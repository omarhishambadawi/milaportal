-- AlShrouq dispatch through Shams CRM.
--
-- The Portal never talks to alshrouqdelivery.com. Every dispatch goes through
-- the same integration the PharmacyCRM Desktop uses -- POST
-- /integrations/alshrouq/orders on https://shams-crm.cloud -- so one system owns
-- the courier relationship and both clients produce the same records. The
-- verified contract is written down in docs/shams/api-discovery.md section 11.

/* -------------------------------------------------------------------------- */
/* 1. The branch mapping                                                       */
/* -------------------------------------------------------------------------- */
-- AlShrouq identifies a pharmacy by its own numeric id, not by the Shams branch
-- code, so the mapping has to live somewhere. It lives on the branch row rather
-- than in a side table: it is one more fact about a branch, it is read on the
-- same query the dispatch panel already runs, and a branch that has no id is
-- simply not dispatchable -- which is the behaviour we want for a branch
-- AlShrouq does not cover.
ALTER TABLE public.branches ADD COLUMN IF NOT EXISTS alshrouq_branch_id text;

-- Unique where present: two branches sharing one AlShrouq id would send a second
-- pharmacy's orders to the first. Partial, because most rows are legitimately
-- null until AlShrouq covers them.
CREATE UNIQUE INDEX IF NOT EXISTS branches_alshrouq_branch_id_key
  ON public.branches (alshrouq_branch_id)
  WHERE alshrouq_branch_id IS NOT NULL;

-- Seeded from the CRM's own "Shams-alshrouq mapping.xlsx" (137 rows). The join
-- is the validation: a code that is not in the Branch Directory updates nothing
-- rather than inserting a branch this system has never heard of. 60 of the
-- workbook's codes (P0041-P0100) are not chain codes in this database and are
-- deliberately left unseeded -- an unmapped branch is refused at dispatch time,
-- which is the safe failure. No credential row from that workbook is reproduced
-- here; only the code -> id pairs.
WITH mapping(branch_no, alshrouq_branch_id) AS (
  VALUES
    ('P0001','9999927657121'), ('P0002','9999927657122'), ('P0003','9999927657123'), ('P0004','9999927657124'), ('P0005','9999927657125'),
    ('P0006','9999927657126'), ('P0007','9999927657127'), ('P0008','9999927657128'), ('P0009','9999927657129'), ('P0010','9999927657130'),
    ('P0011','9999927657131'), ('P0012','9999927657132'), ('P0013','9999927657133'), ('P0014','9999927657134'), ('P0015','9999927657135'),
    ('P0016','9999927657136'), ('P0017','9999927657137'), ('P0018','9999927657138'), ('P0019','9999927657139'), ('P0020','9999927657140'),
    ('P0021','9999927657141'), ('P0022','9999927657142'), ('P0023','9999927657143'), ('P0024','9999927657144'), ('P0025','9999927657145'),
    ('P0026','9999927657146'), ('P0027','9999927657147'), ('P0028','9999927657148'), ('P0029','9999927657149'), ('P0030','9999927657150'),
    ('P0031','9999927657151'), ('P0032','9999927657152'), ('P0033','9999927657153'), ('P0034','9999927657154'), ('P0035','9999927657155'),
    ('P0036','9999927657156'), ('P0037','9999927657157'), ('P0038','9999927657158'), ('P0039','9999927657159'), ('P0040','9999927657160'),
    ('P0041','9999927657161'), ('P0042','9999927657162'), ('P0043','9999927657163'), ('P0044','9999927657164'), ('P0045','9999927657165'),
    ('P0046','9999927657166'), ('P0047','9999927657167'), ('P0048','9999927657168'), ('P0049','9999927657169'), ('P0050','9999927657170'),
    ('P0051','9999927657171'), ('P0052','9999927657172'), ('P0053','9999927657173'), ('P0054','9999927657174'), ('P0055','9999927657175'),
    ('P0056','9999927657176'), ('P0057','9999927657177'), ('P0058','9999927657178'), ('P0059','9999927657179'), ('P0060','9999927657180'),
    ('P0061','9999927657181'), ('P0062','9999927657182'), ('P0063','9999927657183'), ('P0064','9999927657184'), ('P0065','9999927657185'),
    ('P0066','9999927657186'), ('P0067','9999927657187'), ('P0068','9999927657188'), ('P0069','9999927657189'), ('P0070','9999927657190'),
    ('P0071','9999927657191'), ('P0072','9999927657192'), ('P0073','9999927657193'), ('P0074','9999927657194'), ('P0075','9999927657195'),
    ('P0076','9999927657196'), ('P0077','9999927657197'), ('P0078','9999927657198'), ('P0079','9999927657199'), ('P0080','9999927657200'),
    ('P0081','9999927657201'), ('P0082','9999927657202'), ('P0083','9999927657203'), ('P0084','9999927657204'), ('P0085','9999927657205'),
    ('P0086','9999927657206'), ('P0087','9999927657207'), ('P0088','9999927657208'), ('P0089','9999927657209'), ('P0090','9999927657210'),
    ('P0091','9999927657211'), ('P0092','9999927657212'), ('P0093','9999927657213'), ('P0094','9999927657214'), ('P0095','9999927657215'),
    ('P0096','9999927657216'), ('P0097','9999927657217'), ('P0098','9999927657218'), ('P0099','9999927657219'), ('P0100','9999927657220'),
    ('P0101','9999927657221'), ('P0102','9999927657222'), ('P0103','9999927657223'), ('P0104','9999927657224'), ('P0105','9999927657225'),
    ('P0106','9999927657226'), ('P0107','9999927657227'), ('P0108','9999927657228'), ('P0109','9999927657229'), ('P0110','9999927657230'),
    ('P0111','9999927657231'), ('P0112','9999927657232'), ('P0113','9999927657233'), ('P0114','9999927657234'), ('P0115','9999927657235'),
    ('P0116','9999927657236'), ('P0117','9999927657237'), ('P0118','9999927657238'), ('P0119','9999927657239'), ('P0120','9999927657240'),
    ('P0121','9999927657241'), ('P0122','9999927657242'), ('P0123','9999927657243'), ('P0124','9999927657244'), ('P0125','9999927657245'),
    ('P0126','9999927657246'), ('P0127','9999927657247'), ('P0601','9999927657248'), ('P0602','9999927657249'), ('P0603','9999927657250'),
    ('P0604','9999927657251'), ('P0605','9999927657252'), ('P0606','9999927657253'), ('P0607','9999927657254'), ('P0608','9999927657255'),
    ('P0609','9999927657256'), ('P0701','9999927657257')
)
UPDATE public.branches b
   SET alshrouq_branch_id = mapping.alshrouq_branch_id,
       updated_at = now()
  FROM mapping
 WHERE b.branch_no = mapping.branch_no
   AND b.alshrouq_branch_id IS DISTINCT FROM mapping.alshrouq_branch_id;

/* -------------------------------------------------------------------------- */
/* 2. The dispatch record                                                      */
/* -------------------------------------------------------------------------- */
-- One row per order handed to AlShrouq, holding the external reference the CRM
-- returns and the last status it reported. Separate from `orders` because it is
-- a different system's lifecycle: an order can be completed here while the
-- courier record is still moving, and the two must not overwrite each other.
CREATE TABLE IF NOT EXISTS public.alshrouq_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  -- What we told the CRM this order is called. Derived from the order's own
  -- display number, never typed by an agent, so a retry cannot invent a second
  -- identity for one order.
  client_order_id text NOT NULL,
  -- What the CRM calls it back. Nullable only for the window between a create
  -- request and its response being persisted.
  local_id text,
  -- The courier's own status vocabulary, stored verbatim. The Portal does not
  -- translate it: the set of names is not documented anywhere we have verified,
  -- and inventing a mapping would put words in AlShrouq's mouth.
  status text,
  status_detail text,
  branch_no text REFERENCES public.branches(branch_no),
  alshrouq_branch_id text NOT NULL,
  payment_type text NOT NULL,
  details text,
  customer_lat numeric,
  customer_lng numeric,
  value numeric,
  preparation_time integer,
  -- The last refresh payload, so the timeline can be rebuilt without a second
  -- call. Response bodies only; no request headers, no session token.
  last_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  dispatched_by uuid REFERENCES auth.users(id),
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  refreshed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Duplicate protection, in the database rather than only in the server function:
-- an order has at most one live courier record. A cancelled one no longer counts,
-- so a mistaken dispatch can be cancelled and re-sent.
CREATE UNIQUE INDEX IF NOT EXISTS alshrouq_dispatches_live_order_key
  ON public.alshrouq_dispatches (order_id)
  WHERE cancelled_at IS NULL;

-- And the same protection on the identity we hand the CRM.
CREATE UNIQUE INDEX IF NOT EXISTS alshrouq_dispatches_client_order_key
  ON public.alshrouq_dispatches (client_order_id);

GRANT SELECT ON public.alshrouq_dispatches TO authenticated;
GRANT ALL ON public.alshrouq_dispatches TO service_role;

ALTER TABLE public.alshrouq_dispatches ENABLE ROW LEVEL SECURITY;

-- Read access follows the order. The subquery is itself subject to the orders
-- policies, so whoever may see the order may see its dispatch and nobody else --
-- no second copy of the orders visibility rules to drift out of step.
DROP POLICY IF EXISTS "Dispatch visible with its order" ON public.alshrouq_dispatches;
CREATE POLICY "Dispatch visible with its order"
  ON public.alshrouq_dispatches
  FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = alshrouq_dispatches.order_id));

-- No INSERT/UPDATE/DELETE policy or grant for authenticated: every write goes
-- through the server function that actually called the CRM, so a row can never
-- claim a dispatch that did not happen.

CREATE OR REPLACE FUNCTION public.alshrouq_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS alshrouq_dispatches_touch ON public.alshrouq_dispatches;
CREATE TRIGGER alshrouq_dispatches_touch
  BEFORE UPDATE ON public.alshrouq_dispatches
  FOR EACH ROW EXECUTE FUNCTION public.alshrouq_touch_updated_at();
