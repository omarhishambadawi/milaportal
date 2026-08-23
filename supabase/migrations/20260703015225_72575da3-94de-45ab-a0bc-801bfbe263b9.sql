
create table if not exists public.yeastar_token_cache (
  id int primary key default 1,
  access_token text,
  refresh_token text,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  obtained_at timestamptz,
  blocked_until timestamptz,
  block_reason text,
  updated_at timestamptz default now(),
  constraint yeastar_token_singleton check (id = 1)
);

grant all on public.yeastar_token_cache to service_role;
alter table public.yeastar_token_cache enable row level security;

insert into public.yeastar_token_cache (id) values (1) on conflict (id) do nothing;
