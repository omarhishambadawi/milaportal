/**
 * In-memory filter cache. Survives SPA navigation (e.g. edit an order and come
 * back) but is wiped on a full page refresh because the JS module reloads.
 */
export type OrdersFilterCache = {
  range?: { from?: string; to?: string };
  q: string;
  team: string;
  agent: string;
  status: string;
  fulfillment: string;
  mineOnly: boolean;
  page: number;
};
