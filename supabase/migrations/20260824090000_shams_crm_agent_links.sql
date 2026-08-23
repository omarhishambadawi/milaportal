-- Per-agent Shams CRM identities.
--
-- Shams CRM derives `created_by_user_id` and `created_by_username` from the
-- authenticated session, and their API team has confirmed it accepts no
-- caller-supplied attribution, no on-behalf-of header and no service-account
-- impersonation. The session *is* the identity, so the only way an AlShrouq
-- order is recorded against the agent who made it is to log in as that agent.
--
-- This table is the mapping that makes that possible. It is metadata only.
--
-- ## The password is not here
--
-- It is in Vault, under a name derived from the MilaPortal user id, and this
-- table stores only that name. There is deliberately no `crm_password` column
-- and no encrypted-blob column either: a column that can hold a secret is a
-- column somebody eventually selects into a log, a CSV export or a browser.
-- `vault.decrypted_secrets` is reachable only from a SECURITY DEFINER function
-- owned by the database, which is the same mechanism `alshrouq_dispatch_due()`
-- already uses for the scheduler secret.
--
-- ## No client may read it at all
--
-- `alshrouq_dispatches` grants SELECT to `authenticated` because an agent is
-- entitled to see their own order's delivery. Nothing here is like that: a CRM
-- username is another person's credential half, and one agent has no business
-- reading another's. So there is **no policy for any client role** — RLS is on
-- with nothing granted to `authenticated`, and every read goes through a server
-- function running as `service_role`.

-- ---------------------------------------------------------------------------
-- The mapping
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.shams_crm_agent_links (
  -- The MilaPortal agent. One CRM identity per agent, so this is the key.
  user_id       uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,

  -- The CRM login name. Not a secret on its own, and needed to show an admin
  -- which account an agent is linked to without ever revealing the password.
  crm_username  text NOT NULL,

  -- The CRM's own user id, captured from `/me` at verification. Kept so a
  -- dispatch can later be reconciled against what the CRM stamped on the order.
  crm_user_id   text,

  -- Informational. `orders.team` is a property of an order, not of a profile,
  -- so this is not authoritative for anything and gates nothing.
  team          text,

  -- Only a verified link may be used to dispatch. Set false by an admin, or by
  -- the server when the CRM refuses the credential.
  active        boolean NOT NULL DEFAULT false,

  -- When the credential last passed login + /me + the feature check.
  verified_at   timestamptz,

  -- A classification, never a message from the CRM and never a credential:
  -- 'auth_failed' | 'inactive' | 'missing_permission' | 'crm_unreachable'
  -- | 'username_mismatch' | 'not_configured'
  last_error    text,

  -- The Vault entry holding the password. A name, not a value.
  vault_key     text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Two agents cannot share one CRM account: attribution would be ambiguous in
  -- exactly the way this whole design exists to prevent.
  CONSTRAINT shams_crm_agent_links_username_unique UNIQUE (crm_username),

  -- An active link must have been verified and must have somewhere to read its
  -- password from. This is what stops a half-configured row being dispatchable.
  CONSTRAINT shams_crm_agent_links_active_is_verified
    CHECK (active = false OR (verified_at IS NOT NULL AND vault_key IS NOT NULL))
);

COMMENT ON TABLE public.shams_crm_agent_links IS
  'MilaPortal agent -> Shams CRM identity. Metadata only; the password lives in Vault.';
COMMENT ON COLUMN public.shams_crm_agent_links.vault_key IS
  'Name of the Vault secret holding this agent''s CRM password. Never the password.';

-- ---------------------------------------------------------------------------
-- Access: server only
-- ---------------------------------------------------------------------------

ALTER TABLE public.shams_crm_agent_links ENABLE ROW LEVEL SECURITY;

-- Deliberately no GRANT to `authenticated` and no policy for it. With RLS on
-- and no policy, every client read and write is denied; `service_role` bypasses
-- RLS and is how the server functions reach it.
REVOKE ALL ON public.shams_crm_agent_links FROM anon, authenticated;
GRANT ALL ON public.shams_crm_agent_links TO service_role;

-- ---------------------------------------------------------------------------
-- Vault access, narrowly
-- ---------------------------------------------------------------------------

-- Store or replace one agent's CRM password.
--
-- SECURITY DEFINER so the secret never travels through a role a client could
-- assume. It returns the secret's *name*, never its value, so even a caller
-- that logs the result cannot leak the password.
CREATE OR REPLACE FUNCTION public.shams_crm_store_agent_secret(
  _user_id  uuid,
  _password text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  key_name text;
  existing uuid;
BEGIN
  IF _password IS NULL OR length(_password) = 0 THEN
    RAISE EXCEPTION 'a password is required';
  END IF;

  key_name := 'shams_crm_agent_' || _user_id::text;

  SELECT id INTO existing FROM vault.secrets WHERE name = key_name;

  IF existing IS NULL THEN
    PERFORM vault.create_secret(_password, key_name, 'Shams CRM password for a MilaPortal agent');
  ELSE
    PERFORM vault.update_secret(existing, _password, key_name);
  END IF;

  RETURN key_name;
END;
$$;

-- Read one agent's CRM password, for the server that is about to log in as them.
--
-- Returns NULL when the link is absent or inactive rather than raising, so a
-- caller distinguishes "this agent has no CRM account" from "the database
-- failed" — the first is a state the UI reports, the second is an error.
CREATE OR REPLACE FUNCTION public.shams_crm_agent_secret(_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  key_name text;
  secret   text;
BEGIN
  SELECT l.vault_key INTO key_name
    FROM public.shams_crm_agent_links l
   WHERE l.user_id = _user_id AND l.active = true;

  IF key_name IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO secret
    FROM vault.decrypted_secrets WHERE name = key_name;

  RETURN secret;
END;
$$;

-- Remove an agent's stored password. Used when a link is deleted or an account
-- is offboarded: a credential that outlives the mapping is a live credential
-- nobody is watching.
CREATE OR REPLACE FUNCTION public.shams_crm_forget_agent_secret(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
BEGIN
  DELETE FROM vault.secrets WHERE name = 'shams_crm_agent_' || _user_id::text;
  UPDATE public.shams_crm_agent_links
     SET vault_key = NULL, active = false, updated_at = now()
   WHERE user_id = _user_id;
END;
$$;

-- Only the server may call these. `authenticated` must not be able to ask the
-- database for a password, whatever else it holds.
REVOKE ALL ON FUNCTION public.shams_crm_store_agent_secret(uuid, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.shams_crm_agent_secret(uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.shams_crm_forget_agent_secret(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shams_crm_store_agent_secret(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shams_crm_agent_secret(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.shams_crm_forget_agent_secret(uuid) TO service_role;
