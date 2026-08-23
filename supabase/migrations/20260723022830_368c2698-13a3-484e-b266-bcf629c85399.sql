DROP TRIGGER IF EXISTS trg_notify_order ON public.orders;
DROP TRIGGER IF EXISTS trg_notify_complaint ON public.complaints;
DROP FUNCTION IF EXISTS public.notify_on_order_change();
DROP FUNCTION IF EXISTS public.notify_on_complaint_change();