DROP TRIGGER IF EXISTS trg_orders_updated_at ON public.orders;
DROP TRIGGER IF EXISTS trg_complaints_updated_at ON public.complaints;
DROP TRIGGER IF EXISTS trg_prevent_order_reassignment ON public.orders;
DROP TRIGGER IF EXISTS trg_order_activity ON public.orders;
DROP TRIGGER IF EXISTS trg_order_notifications ON public.orders;
DROP TRIGGER IF EXISTS trg_complaint_activity ON public.complaints;
DROP TRIGGER IF EXISTS trg_complaint_notifications ON public.complaints;

CREATE TRIGGER trg_orders_updated_at
BEFORE UPDATE ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_complaints_updated_at
BEFORE UPDATE ON public.complaints
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_prevent_order_reassignment
BEFORE UPDATE ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.prevent_order_reassignment();

CREATE TRIGGER trg_order_activity
AFTER INSERT OR UPDATE ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.log_order_activity();

CREATE TRIGGER trg_order_notifications
AFTER INSERT OR UPDATE ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.notify_on_order_change();

CREATE TRIGGER trg_complaint_activity
AFTER INSERT OR UPDATE ON public.complaints
FOR EACH ROW
EXECUTE FUNCTION public.log_complaint_activity();

CREATE TRIGGER trg_complaint_notifications
AFTER INSERT OR UPDATE ON public.complaints
FOR EACH ROW
EXECUTE FUNCTION public.notify_on_complaint_change();