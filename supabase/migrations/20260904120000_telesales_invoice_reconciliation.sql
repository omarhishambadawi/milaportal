-- Telesales CRM: the invoice reconciliation verdict, stored.
--
-- ===========================================================================
-- Five columns, not a table
-- ===========================================================================
-- The reconciliation is a property *of a lead* — "did this lead become a real
-- sale" — so it lives on the lead. A `telesales_invoice_matches` table would
-- add a join to every management query to hold one row per lead with a
-- one-to-one relationship, and it would need its own archive rules.
--
-- Columns on the lead archive with the lead, which is what
-- `20260903120000` requires: removing a source import must take its
-- reconciliation with it and leave nothing dangling.
--
-- ===========================================================================
-- What is deliberately NOT stored
-- ===========================================================================
-- The invoice. Not its lines, not its totals, not its customer account label.
--
-- Shams MIS is the source of truth for what it sold, and a copy of an invoice
-- inside Telesales is a second version of a commercial record that ages apart
-- from the original. What is stored is the *relationship* — this lead points at
-- that document at that branch, and here is what we concluded — which is enough
-- to answer "which leads converted" without re-asking the MIS about every one,
-- and small enough that it cannot drift into being an accounting record.
--
-- The verdict is re-derived live every time a lead is opened. These columns are
-- the reporting shadow of that, not its cache.

ALTER TABLE public.telesales_leads
  -- 'matched' | 'not_matched' | 'ambiguous' | 'not_checked'. Text with a CHECK
  -- rather than an enum, so the reconciler can learn a fifth verdict without a
  -- type migration.
  ADD COLUMN IF NOT EXISTS invoice_match_status text
    CHECK (invoice_match_status IS NULL OR invoice_match_status IN
      ('matched', 'not_matched', 'ambiguous', 'not_checked')),

  -- The document actually matched, and the warehouse it was found at. Both,
  -- always: a Shams document number is unique only within a branch, which is
  -- the single most important fact about this whole feature. MilaPortal's own
  -- orders table has 29 invoice numbers appearing against more than one branch.
  ADD COLUMN IF NOT EXISTS invoice_matched_doc_no text,
  ADD COLUMN IF NOT EXISTS invoice_matched_branch_no text,

  -- What disagreed, as the reconciler's own keys. Kept so a supervisor can ask
  -- "show me the leads whose product was not on the invoice" without re-running
  -- anything.
  ADD COLUMN IF NOT EXISTS invoice_discrepancies text[] NOT NULL DEFAULT '{}',

  -- When the verdict was reached. Its staleness is the point: a verdict from
  -- three weeks ago is a fact about three weeks ago, and the UI re-derives live
  -- rather than trusting this.
  ADD COLUMN IF NOT EXISTS invoice_checked_at timestamptz;

-- The supervisor read: "which of this week's leads turned into invoices".
-- Partial, because a lead nobody has opened has no verdict and there is no
-- point indexing several hundred thousand nulls.
CREATE INDEX IF NOT EXISTS telesales_leads_invoice_match_idx
  ON public.telesales_leads (invoice_match_status, invoice_checked_at DESC)
  WHERE invoice_match_status IS NOT NULL;

COMMENT ON COLUMN public.telesales_leads.invoice_match_status IS
  'Reconciliation verdict against Shams MIS. A reporting shadow of a live '
  'derivation, not a cache -- the lead detail always re-derives. NULL means '
  'nobody has opened this lead since reconciliation existed.';

COMMENT ON COLUMN public.telesales_leads.invoice_matched_branch_no IS
  'Always stored with invoice_matched_doc_no. A Shams document number is unique '
  'only within a warehouse.';
