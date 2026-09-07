import { auth, defineMcp } from "@lovable.dev/mcp-js";
import whoami from "./tools/whoami";
import listOrders from "./tools/list-orders";
import getOrder from "./tools/get-order";
import listComplaints from "./tools/list-complaints";
import ordersSummary from "./tools/orders-summary";

// The OAuth issuer must be the caller's actual GoTrue host, matching the
// `iss` claim on the token. On Supabase Cloud that is not necessarily
// SUPABASE_URL — publish can rewrite it to a .lovable.cloud proxy — so the
// Cloud case keeps deriving the direct host from VITE_SUPABASE_PROJECT_ID
// (inlined by Vite at build time and unaffected by that rewrite). Self-hosted
// Supabase has no Cloud project ref, so it falls back to SUPABASE_URL, which
// there points at the instance directly.
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID;
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const issuerHost = projectRef
  ? `https://${projectRef}.supabase.co`
  : (supabaseUrl ?? "https://project-ref-unset.supabase.co").replace(/\/+$/, "");

export default defineMcp({
  name: "milaserv-daily-log-mcp",
  title: "MilaServ Portal",
  version: "0.1.0",
  instructions:
    "Tools for the MilaServ Portal app. Use `whoami` to confirm the signed-in user. Use `list_orders`, `get_order`, and `orders_summary` for order data (filter by date range, team, status). Use `list_complaints` for complaint data. All data is scoped to what the signed-in user is allowed to see.",
  auth: auth.oauth.issuer({
    issuer: `${issuerHost}/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [whoami, listOrders, getOrder, listComplaints, ordersSummary],
});
