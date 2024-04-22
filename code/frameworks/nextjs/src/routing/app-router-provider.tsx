import React, { useMemo } from 'react';
import {
  LayoutRouterContext,
  AppRouterContext,
  GlobalLayoutRouterContext,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  PathnameContext,
  SearchParamsContext,
  PathParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { type Params } from 'next/dist/shared/lib/router/utils/route-matcher';
import { PAGE_SEGMENT_KEY } from 'next/dist/shared/lib/segment';
import type { FlightRouterState } from 'next/dist/server/app-render/types';
import type { RouteParams } from './types';

type AppRouterProviderProps = {
  action: (name: string) => (...args: any[]) => void;
  routeParams: RouteParams;
};

// Since Next 14.2.x
// https://github.com/vercel/next.js/pull/60708/files#diff-7b6239af735eba0c401e1a0db1a04dd4575c19a031934f02d128cf3ac813757bR106
function getSelectedParams(currentTree: FlightRouterState, params: Params = {}): Params {
  const parallelRoutes = currentTree[1];

  for (const parallelRoute of Object.values(parallelRoutes)) {
    const segment = parallelRoute[0];
    const isDynamicParameter = Array.isArray(segment);
    const segmentValue = isDynamicParameter ? segment[1] : segment;
    if (!segmentValue || segmentValue.startsWith(PAGE_SEGMENT_KEY)) continue;

    // Ensure catchAll and optional catchall are turned into an array
    const isCatchAll = isDynamicParameter && (segment[2] === 'c' || segment[2] === 'oc');

    if (isCatchAll) {
      params[segment[0]] = segment[1].split('/');
    } else if (isDynamicParameter) {
      params[segment[0]] = segment[1];
    }

    params = getSelectedParams(parallelRoute, params);
  }

  return params;
}

const getParallelRoutes = (segmentsList: Array<string>): FlightRouterState => {
  const segment = segmentsList.shift();

  if (segment) {
    return [segment, { children: getParallelRoutes(segmentsList) }];
  }

  return [] as any;
};

export const AppRouterProvider: React.FC<React.PropsWithChildren<AppRouterProviderProps>> = ({
  children,
  action,
  routeParams,
}) => {
  const { pathname, query, segments = [], ...restRouteParams } = routeParams;

  const tree: FlightRouterState = [pathname, { children: getParallelRoutes([...segments]) }];
  const pathParams = useMemo(() => {
    return getSelectedParams(tree);
  }, [tree]);

  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/app-router.tsx#L436
  return (
    <PathParamsContext.Provider value={pathParams}>
      <PathnameContext.Provider value={pathname}>
        <SearchParamsContext.Provider value={new URLSearchParams(query)}>
          <GlobalLayoutRouterContext.Provider
            value={{
              changeByServerResponse() {
                // NOOP
              },
              buildId: 'storybook',
              tree,
              focusAndScrollRef: {
                apply: false,
                hashFragment: null,
                segmentPaths: [tree],
                onlyHashChange: false,
              },
              nextUrl: pathname,
            }}
          >
            <AppRouterContext.Provider
              value={{
                push(...args) {
                  action('nextNavigation.push')(...args);
                },
                replace(...args) {
                  action('nextNavigation.replace')(...args);
                },
                forward(...args) {
                  action('nextNavigation.forward')(...args);
                },
                back(...args) {
                  action('nextNavigation.back')(...args);
                },
                prefetch(...args) {
                  action('nextNavigation.prefetch')(...args);
                },
                refresh: () => {
                  action('nextNavigation.refresh')();
                },
                ...restRouteParams,
              }}
            >
              <LayoutRouterContext.Provider
                value={{
                  childNodes: new Map(),
                  tree,
                  url: pathname,
                }}
              >
                {children}
              </LayoutRouterContext.Provider>
            </AppRouterContext.Provider>
          </GlobalLayoutRouterContext.Provider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </PathParamsContext.Provider>
  );
};
