-- Whose delivery a dispatch is, told apart from who pressed send.
--
-- `dispatched_by` and `scheduled_by` record the MilaPortal account that acted.
-- Until now they doubled as the *attribution*: the worker logged in to Shams CRM
-- as `scheduled_by`, and the immediate path logged in as the caller. That is
-- correct only while the two are the same person.
--
-- They are not the same person whenever a supervisor or administrator hands an
-- order over on an agent's behalf. Those accounts hold `edit_all_orders` and are
-- deliberately absent from `shams_crm_agent_links` — they have no Shams CRM
-- account, because they are not CRM agents — so the handoff stopped with
-- `agent_not_configured` for an order whose own agent was perfectly well linked.
--
-- The order's agent is the answer. MilaPortal already separates the two:
-- `orders.agent_id` is the assignee and `orders.created_by` defaults to
-- `auth.uid()`, so the delivery belongs to the agent servicing the order. This
-- column carries that agent onto the dispatch row, so the CRM's
-- `created_by_user_id` agrees with `agent_id` rather than with whoever clicked.
--
-- ## Why it is stored rather than re-read
--
-- The worker runs hours later and never reads the order — the same reason
-- `payload_snapshot` exists. What goes out is what was approved, including whose
-- delivery it is, so reassigning an order after approval cannot silently move a
-- pending delivery onto somebody else's name.
--
-- ## Backfill
--
-- None, deliberately. Existing rows are all immediate dispatches that were made
-- by agents for their own orders, where the two values coincide; the worker
-- falls back to `scheduled_by` for any row written before this column existed.
-- Inventing an agent id for a historical delivery would be a claim about who
-- serviced it that this migration is in no position to make.

ALTER TABLE public.alshrouq_dispatches
  ADD COLUMN IF NOT EXISTS crm_agent_id uuid REFERENCES auth.users(id);

COMMENT ON COLUMN public.alshrouq_dispatches.crm_agent_id IS
  'The order''s assigned agent at approval time — the Shams CRM identity this delivery is sent under. Not who pressed send; that is dispatched_by / scheduled_by.';

-- No policy or grant change. The table's single policy is SELECT for
-- `authenticated`, every write goes through `service_role`, and a new column
-- inherits both.
