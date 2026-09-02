-- Telesales CRM: configured product relationships, for cross-sell.
--
-- ===========================================================================
-- Why this table exists, and why it ships empty
-- ===========================================================================
-- Cross-sell needs to answer "the customer bought A, is there a B worth
-- mentioning". That answer must come from somebody who knows the business.
--
-- It cannot be mined from the data we hold. Of the product pairs bought by the
-- same customer in the live extract, the nine supported by more than one
-- customer are all *within a single product family* -- two Mounjaro strengths,
-- two Libre SKUs -- which is a dose change or a substitution, not a companion
-- product. Every cross-family pair rests on exactly one customer. Nine
-- same-family pairs and thirty single-customer coincidences is not a
-- relationship model; treating it as one would put a medication recommendation
-- in front of a patient on the strength of one other person's basket.
--
-- So the rule is implemented, tested, and reads from here. The table is created
-- empty and stays empty until the desk configures a pair. A cross-sell
-- recommendation therefore cannot appear until a human has asserted the
-- relationship, which is the only honest source for one.
--
-- `telesales_product_patterns` was inspected first and is not this: it
-- classifies a product name into a family and decides eligibility. It carries
-- no notion of one product relating to another.

CREATE TABLE IF NOT EXISTS public.telesales_product_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The product the customer already bought, and the one to raise. Both are
  -- item codes in the pharmacy's own space -- the same identifier
  -- `telesales_products.item_code` and the MIS `itemcode` use -- so no mapping
  -- layer is involved.
  from_item_code text NOT NULL,
  to_item_code   text NOT NULL,

  -- Denormalised for display: the recommended product is frequently one the
  -- Telesales catalogue does not carry a row for, and the agent still needs to
  -- read its name.
  to_item_name text NOT NULL,

  -- The desk's own words for why the pair exists. Rendered verbatim to the
  -- agent, so the justification travels with the recommendation instead of
  -- being asserted by the software.
  note text,

  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A pair is configured once. Re-configuring it is an UPDATE.
  CONSTRAINT telesales_product_relations_pair_key UNIQUE (from_item_code, to_item_code),

  -- A product is not a companion to itself.
  CONSTRAINT telesales_product_relations_distinct CHECK (from_item_code <> to_item_code)
);

CREATE INDEX IF NOT EXISTS telesales_product_relations_from_idx
  ON public.telesales_product_relations (from_item_code)
  WHERE active;

ALTER TABLE public.telesales_product_relations ENABLE ROW LEVEL SECURITY;

-- Reading is part of seeing the queue: the recommendation explains itself with
-- the relation's own name and note, so an agent who can view Telesales can read
-- the configuration behind what they are being shown.
DROP POLICY IF EXISTS telesales_product_relations_select ON public.telesales_product_relations;
CREATE POLICY telesales_product_relations_select
  ON public.telesales_product_relations
  FOR SELECT
  TO authenticated
  USING (public.has_permission(auth.uid(), 'view_telesales'));

-- No INSERT/UPDATE/DELETE policy, matching the rest of the module: every write
-- goes through a server function running as service_role which checks
-- `manage_telesales` itself. Configuring a commercial relationship between two
-- medications is a supervisor act, not an agent one.

COMMENT ON TABLE public.telesales_product_relations IS
  'Explicitly configured cross-sell pairs. Empty by design -- the live '
  'co-purchase data does not support inferring product relationships, so a '
  'cross-sell recommendation requires a human to assert the pair.';

COMMENT ON COLUMN public.telesales_product_relations.note IS
  'The desk''s reason for the pair. Shown to the agent verbatim.';
