import { format } from "date-fns";

/** Date → "yyyy-MM-dd" (the wire format every dashboard RPC expects). */
export const toISO = (d: Date) => format(d, "yyyy-MM-dd");

/** Team code → display label. */
export const teamLabel = (t: string) => (t === "telesales" ? "Telesales" : "Customer Care");
