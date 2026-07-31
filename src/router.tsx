import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { createAppQueryClient } from "./lib/query-client";

export const getRouter = () => {
  // Defaults (staleTime, gcTime, retry, refetchOn*) live in lib/query-client.ts.
  const queryClient = createAppQueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // Fetch a route's chunk when the user shows intent (hover, or touch-start
    // on mobile) instead of waiting for the click. Every route is code-split,
    // so this removes a network round-trip from the critical path of a
    // navigation. Data staleness is unchanged: React Query still owns it, and
    // `defaultPreloadStaleTime: 0` keeps preloaded route data from being
    // treated as fresh.
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
  });

  return router;
};
