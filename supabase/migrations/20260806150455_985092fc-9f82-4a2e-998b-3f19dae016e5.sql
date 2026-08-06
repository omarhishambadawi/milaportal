create index if not exists orders_team_date_idx
  on public.orders (team, order_date)
  include (agent_id, status, order_type, invoice_value);

create index if not exists orders_agent_date_idx
  on public.orders (agent_id, order_date)
  include (status, order_type, invoice_value);

analyze public.orders;