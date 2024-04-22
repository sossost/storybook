import path from 'path';
import { describe, expect, it } from 'vitest';
import { getStoryId } from './get-story-id';

describe('getStoryId', () => {
  it('should return the storyId', async () => {
    const cwd = process.cwd();
    const options = {
      configDir: path.join(cwd, '.storybook'),
      presets: {
        apply: (val: string) => {
          if (val === 'stories') {
            return Promise.resolve(['../src/**/*.stories.@(js|jsx|mjs|ts|tsx)']);
          }
        },
      },
    } as any;
    const storyFilePath = path.join(cwd, 'src', 'components', 'stories', 'Page1.stories.ts');
    const exportedStoryName = 'Default';

    const storyId = await getStoryId({ storyFilePath, exportedStoryName }, options);

    expect(storyId).toBe('components-stories-page1--default');
  });

  it('should throw an error if the storyId cannot be calculated', async () => {
    const cwd = process.cwd();
    const options = {
      configDir: path.join(cwd, '.storybook'),
      presets: {
        apply: (val: string) => {
          if (val === 'stories') {
            return Promise.resolve(['../src/**/*.stories.@(js|jsx|mjs|ts|tsx)']);
          }
        },
      },
    } as any;
    const storyFilePath = path.join(cwd, 'not-covered-path', 'stories', 'Page1.stories.ts');
    const exportedStoryName = 'Default';

    await expect(() =>
      getStoryId({ storyFilePath, exportedStoryName }, options)
    ).rejects.toThrowError();
  });
});
