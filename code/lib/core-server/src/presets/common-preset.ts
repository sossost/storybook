import fs, { pathExists, readFile } from 'fs-extra';
import { logger } from '@storybook/node-logger';
import { telemetry } from '@storybook/telemetry';
import {
  findConfigFile,
  getDirectoryFromWorkingDir,
  getPreviewBodyTemplate,
  getPreviewHeadTemplate,
  loadEnvs,
  removeAddon as removeAddonBase,
} from '@storybook/core-common';
import type {
  CLIOptions,
  CoreConfig,
  Indexer,
  Options,
  PresetPropertyFn,
  PresetProperty,
} from '@storybook/types';
import { printConfig, readConfig, readCsf } from '@storybook/csf-tools';
import { join, dirname, isAbsolute } from 'path';
import { dedent } from 'ts-dedent';
import fetch from 'node-fetch';
import type { Channel } from '@storybook/channels';
import type { WhatsNewCache, WhatsNewData } from '@storybook/core-events';
import {
  REQUEST_WHATS_NEW_DATA,
  RESULT_WHATS_NEW_DATA,
  TELEMETRY_ERROR,
  SET_WHATS_NEW_CACHE,
  TOGGLE_WHATS_NEW_NOTIFICATIONS,
} from '@storybook/core-events';
import invariant from 'tiny-invariant';
import { parseStaticDir } from '../utils/server-statics';
import { defaultStaticDirs } from '../utils/constants';
import { sendTelemetryError } from '../withTelemetry';
import { initFileSearchChannel } from '../server-channel/file-search-channel';
import { initCreateNewStoryChannel } from '../server-channel/create-new-story-channel';

const interpolate = (string: string, data: Record<string, string> = {}) =>
  Object.entries(data).reduce((acc, [k, v]) => acc.replace(new RegExp(`%${k}%`, 'g'), v), string);

const defaultFavicon = require.resolve('@storybook/core-server/public/favicon.svg');

export const staticDirs: PresetPropertyFn<'staticDirs'> = async (values = []) => [
  ...defaultStaticDirs,
  ...values,
];

export const favicon = async (
  value: string | undefined,
  options: Pick<Options, 'presets' | 'configDir'>
) => {
  if (value) {
    return value;
  }
  const staticDirsValue = await options.presets.apply('staticDirs');

  const statics = staticDirsValue
    ? staticDirsValue.map((dir) => (typeof dir === 'string' ? dir : `${dir.from}:${dir.to}`))
    : [];

  if (statics && statics.length > 0) {
    const lists = await Promise.all(
      statics.map(async (dir) => {
        const results = [];
        const normalizedDir =
          staticDirsValue && !isAbsolute(dir)
            ? getDirectoryFromWorkingDir({
                configDir: options.configDir,
                workingDir: process.cwd(),
                directory: dir,
              })
            : dir;

        const { staticPath, targetEndpoint } = await parseStaticDir(normalizedDir);

        if (targetEndpoint === '/') {
          const url = 'favicon.svg';
          const path = join(staticPath, url);
          if (await pathExists(path)) {
            results.push(path);
          }
        }
        if (targetEndpoint === '/') {
          const url = 'favicon.ico';
          const path = join(staticPath, url);
          if (await pathExists(path)) {
            results.push(path);
          }
        }

        return results;
      })
    );
    const flatlist = lists.reduce((l1, l2) => l1.concat(l2), []);

    if (flatlist.length > 1) {
      logger.warn(dedent`
        Looks like multiple favicons were detected. Using the first one.
        
        ${flatlist.join(', ')}
        `);
    }

    return flatlist[0] || defaultFavicon;
  }

  return defaultFavicon;
};

export const babel = async (_: unknown, options: Options) => {
  const { presets } = options;

  return presets.apply('babelDefault', {}, options);
};

export const title = (previous: string, options: Options) =>
  previous || options.packageJson.name || false;

export const logLevel = (previous: any, options: Options) => previous || options.loglevel || 'info';

export const previewHead = async (base: any, { configDir, presets }: Options) => {
  const interpolations = await presets.apply<Record<string, string>>('env');
  return getPreviewHeadTemplate(configDir, interpolations);
};

export const env = async () => {
  return loadEnvs({ production: true }).raw;
};

export const previewBody = async (base: any, { configDir, presets }: Options) => {
  const interpolations = await presets.apply<Record<string, string>>('env');
  return getPreviewBodyTemplate(configDir, interpolations);
};

export const typescript = () => ({
  check: false,
  // 'react-docgen' faster than `react-docgen-typescript` but produces lower quality results
  reactDocgen: 'react-docgen',
  reactDocgenTypescriptOptions: {
    shouldExtractLiteralValuesFromEnum: true,
    shouldRemoveUndefinedFromOptional: true,
    propFilter: (prop: any) => (prop.parent ? !/node_modules/.test(prop.parent.fileName) : true),
    // NOTE: this default cannot be changed
    savePropValueAsString: true,
  },
});

const optionalEnvToBoolean = (input: string | undefined): boolean | undefined => {
  if (input === undefined) {
    return undefined;
  }
  if (input.toUpperCase() === 'FALSE') {
    return false;
  }
  if (input.toUpperCase() === 'TRUE') {
    return true;
  }
  if (typeof input === 'string') {
    return true;
  }
  return undefined;
};

// eslint-disable-next-line @typescript-eslint/naming-convention
export const experimental_serverAPI = (extension: Record<string, Function>, options: Options) => {
  let removeAddon = removeAddonBase;
  if (!options.disableTelemetry) {
    removeAddon = async (id: string, opts: any) => {
      await telemetry('remove', { addon: id, source: 'api' });
      return removeAddonBase(id, opts);
    };
  }
  return { ...extension, removeAddon };
};

/**
 * If for some reason this config is not applied, the reason is that
 * likely there is an addon that does `export core = () => ({ someConfig })`,
 * instead of `export core = (existing) => ({ ...existing, someConfig })`,
 * just overwriting everything and not merging with the existing values.
 */
export const core = async (existing: CoreConfig, options: Options): Promise<CoreConfig> => ({
  ...existing,
  disableTelemetry: options.disableTelemetry === true || options.test === true,
  enableCrashReports:
    options.enableCrashReports || optionalEnvToBoolean(process.env.STORYBOOK_ENABLE_CRASH_REPORTS),
});

export const features: PresetProperty<'features'> = async (existing) => ({
  ...existing,
  argTypeTargetsV7: true,
  legacyDecoratorFileOrder: false,
  disallowImplicitActionsInRenderV8: true,
});

export const csfIndexer: Indexer = {
  test: /(stories|story)\.(m?js|ts)x?$/,
  createIndex: async (fileName, options) => (await readCsf(fileName, options)).parse().indexInputs,
};

// eslint-disable-next-line @typescript-eslint/naming-convention
export const experimental_indexers: PresetProperty<'experimental_indexers'> = (existingIndexers) =>
  [csfIndexer].concat(existingIndexers || []);

export const frameworkOptions = async (
  _: never,
  options: Options
): Promise<Record<string, any> | null> => {
  const config = await options.presets.apply('framework');

  if (typeof config === 'string') {
    return {};
  }

  if (typeof config === 'undefined') {
    return null;
  }

  return config.options;
};

export const docs: PresetProperty<'docs'> = (docsOptions, { docs: docsMode }: CLIOptions) =>
  docsOptions && docsMode !== undefined
    ? {
        ...docsOptions,
        docsMode,
      }
    : docsOptions;

export const managerHead = async (_: any, options: Options) => {
  const location = join(options.configDir, 'manager-head.html');
  if (await pathExists(location)) {
    const contents = readFile(location, 'utf-8');
    const interpolations = options.presets.apply<Record<string, string>>('env');

    return interpolate(await contents, await interpolations);
  }

  return '';
};

const WHATS_NEW_CACHE = 'whats-new-cache';
const WHATS_NEW_URL = 'https://storybook.js.org/whats-new/v1';

// Grabbed from the implementation: https://github.com/storybookjs/dx-functions/blob/main/netlify/functions/whats-new.ts
type WhatsNewResponse = {
  title: string;
  url: string;
  blogUrl?: string;
  publishedAt: string;
  excerpt: string;
};

type OptionsWithRequiredCache = Exclude<Options, 'cache'> & Required<Pick<Options, 'cache'>>;

// eslint-disable-next-line @typescript-eslint/naming-convention
export const experimental_serverChannel = async (
  channel: Channel,
  options: OptionsWithRequiredCache
) => {
  const coreOptions = await options.presets.apply('core');

  channel.on(SET_WHATS_NEW_CACHE, async (data: WhatsNewCache) => {
    const cache: WhatsNewCache = await options.cache.get(WHATS_NEW_CACHE).catch((e) => {
      logger.verbose(e);
      return {};
    });
    await options.cache.set(WHATS_NEW_CACHE, { ...cache, ...data });
  });

  channel.on(REQUEST_WHATS_NEW_DATA, async () => {
    try {
      const post = (await fetch(WHATS_NEW_URL).then(async (response) => {
        if (response.ok) return response.json();
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw response;
      })) as WhatsNewResponse;

      const configFileName = findConfigFile('main', options.configDir);
      if (!configFileName)
        throw new Error(`unable to find storybook main file in ${options.configDir}`);
      const main = await readConfig(configFileName);
      const disableWhatsNewNotifications = main.getFieldValue([
        'core',
        'disableWhatsNewNotifications',
      ]);

      const cache: WhatsNewCache = (await options.cache.get(WHATS_NEW_CACHE)) ?? {};
      const data = {
        ...post,
        status: 'SUCCESS',
        postIsRead: post.url === cache.lastReadPost,
        showNotification: post.url !== cache.lastDismissedPost && post.url !== cache.lastReadPost,
        disableWhatsNewNotifications,
      } satisfies WhatsNewData;
      channel.emit(RESULT_WHATS_NEW_DATA, { data });
    } catch (e) {
      logger.verbose(e instanceof Error ? e.message : String(e));
      channel.emit(RESULT_WHATS_NEW_DATA, {
        data: { status: 'ERROR' } satisfies WhatsNewData,
      });
    }
  });

  channel.on(
    TOGGLE_WHATS_NEW_NOTIFICATIONS,
    async ({ disableWhatsNewNotifications }: { disableWhatsNewNotifications: boolean }) => {
      const isTelemetryEnabled = coreOptions.disableTelemetry !== true;
      try {
        const mainPath = findConfigFile('main', options.configDir);
        invariant(mainPath, `unable to find storybook main file in ${options.configDir}`);
        const main = await readConfig(mainPath);
        main.setFieldValue(['core', 'disableWhatsNewNotifications'], disableWhatsNewNotifications);
        await fs.writeFile(mainPath, printConfig(main).code);
        if (isTelemetryEnabled) {
          await telemetry('core-config', { disableWhatsNewNotifications });
        }
      } catch (error) {
        invariant(error instanceof Error);
        if (isTelemetryEnabled) {
          await sendTelemetryError(error, 'core-config', {
            cliOptions: options,
            presetOptions: { ...options, corePresets: [], overridePresets: [] },
            skipPrompt: true,
          });
        }
      }
    }
  );

  channel.on(TELEMETRY_ERROR, async (error) => {
    const isTelemetryEnabled = coreOptions.disableTelemetry !== true;

    if (isTelemetryEnabled) {
      await sendTelemetryError(error, 'browser', {
        cliOptions: options,
        presetOptions: { ...options, corePresets: [], overridePresets: [] },
        skipPrompt: true,
      });
    }
  });

  initFileSearchChannel(channel, options);
  initCreateNewStoryChannel(channel, options);

  return channel;
};

/**
 * Try to resolve react and react-dom from the root node_modules of the project
 * addon-docs uses this to alias react and react-dom to the project's version when possible
 * If the user doesn't have an explicit dependency on react this will return the existing values
 * Which will be the versions shipped with addon-docs
 */
export const resolvedReact = async (existing: any) => {
  try {
    return {
      ...existing,
      react: dirname(require.resolve('react/package.json')),
      reactDom: dirname(require.resolve('react-dom/package.json')),
    };
  } catch (e) {
    return existing;
  }
};

/**
 * Set up `dev-only`, `docs-only`, `test-only` tags out of the box
 */
export const tags = async (existing: any) => {
  return {
    ...existing,
    'dev-only': { excludeFromDocsStories: true },
    'docs-only': { excludeFromSidebar: true },
    'test-only': { excludeFromSidebar: true, excludeFromDocsStories: true },
  };
};

export const managerEntries = async (existing: any, options: Options) => {
  return [require.resolve('./common-manager'), ...(existing || [])];
};
