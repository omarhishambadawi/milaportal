GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, text) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.is_active(uuid) TO authenticated, anon, service_role;