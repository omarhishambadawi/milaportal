
REVOKE EXECUTE ON FUNCTION public.prevent_profile_escalation() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_order_reassignment() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.orders ALTER COLUMN display_no SET DEFAULT ('#' || nextval('public.order_display_seq')::text);
