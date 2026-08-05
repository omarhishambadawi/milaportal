-- Composite indexes for the Calls analytics orders join.
--
-- `getCallCenterAnalytics` (Telesales conversion) runs:
--
--   select id, agent_id, order_date, status, order_type, invoice_value
--     from orders
--    where order_date between $from and $to
--      [and team = $team]
--      [and agent_id = $agent]
--
-- The table had only single-column indexes (order_date, team, agent_id), so a
-- month-wide scoped query took the date index and then re-checked team/agent as
-- a filter on every candidate row — and had to visit the heap for all of them,
-- because none of the selected columns were in the index.
--
-- These two composites lead with the equality column and range on the date,
-- which is the order btree can actually use for both predicates at once. The
-- INCLUDE list carries the remaining selected columns so the planner can serve
-- the query index-only, without touching the heap at all.
--
-- Additive only: no existing index is dropped, so every other query keeps the
-- plan it has today.

create index if not exists orders_team_date_idx
  on public.orders (team, order_date)
  include (agent_id, status, order_type, invoice_value);

create index if not exists orders_agent_date_idx
  on public.orders (agent_id, order_date)
  include (status, order_type, invoice_value);

-- Keeps the planner's row estimates honest for the new composites straight
-- away rather than at the next autovacuum.
analyze public.orders;
