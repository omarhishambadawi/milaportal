import { auth, defineMcp } from "@lovable.dev/mcp-js";
import whoami from "./tools/whoami";
import listOrders from "./tools/list-orders";
import getOrder from "./tools/get-order";
import listComplaints from "./tools/list-complaints";
import ordersSummary from "./tools/orders-summary";

// The OAuth issuer must be the caller's actual GoTrue host, matching the `iss`
// claim on the token — which is the Supabase instance this build points at, so
// it is derived from that one URL and nothing else. An earlier version preferred
// a separate VITE_SUPABASE_PROJECT_ID, rebuilt into `https://<ref>.supabase.co`;
// that name is gone, because it could keep the issuer on one instance while the
// data path moved to another, and the split showed up nowhere else.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const issuerHost = supabaseUrl.replace(/\/+$/, "");

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
