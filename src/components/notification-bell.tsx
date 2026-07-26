import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Bell, CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";

function timeAgo(iso: string) {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function NotificationBell() {
  const { user } = useAuth();
  const qc = useQueryClient();

  // Realtime is the primary update path (see the subscription below). Polling is
  // only a fallback for when the realtime channel is down, so it stays disabled
  // while the channel is SUBSCRIBED and switches on if the connection degrades.
  const [realtimeConnected, setRealtimeConnected] = useState(false);

  const { data } = useQuery({
    queryKey: queryKeys.notifications.list(user?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications" as any)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) throw error;
      return (data as any[]) ?? [];
    },
    enabled: !!user,
    // No fixed poll: realtime pushes changes instantly. Fall back to a slow 60s
    // poll only while realtime is disconnected, so the bell still recovers if the
    // websocket silently drops.
    refetchInterval: realtimeConnected ? false : 60_000,
  });

  // Realtime subscription — the primary mechanism for keeping the bell current.
  useEffect(() => {
    if (!user?.id) return;
    // Tracks whether the channel has previously dropped, so we only force a
    // catch-up refetch on genuine reconnects, not on the initial subscribe (the
    // query already fetches on mount).
    let wasDisconnected = false;
    const ch = supabase
      .channel(`notif-${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${user.id}` },
        () => qc.invalidateQueries({ queryKey: queryKeys.notifications.all() }),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setRealtimeConnected(true);
          // Reconnected after a drop: refetch once to pull in anything the
          // channel missed while it was down.
          if (wasDisconnected) {
            wasDisconnected = false;
            qc.invalidateQueries({ queryKey: queryKeys.notifications.all() });
          }
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          wasDisconnected = true;
          setRealtimeConnected(false);
        }
      });
    return () => {
      setRealtimeConnected(false);
      supabase.removeChannel(ch);
    };
  }, [user?.id, qc]);

  const items = data ?? [];
  const unread = items.filter((n) => !n.read_at).length;

  const markAllRead = async () => {
    if (!user) return;
    await supabase
      .from("notifications" as any)
      .update({ read_at: new Date().toISOString() } as any)
      .is("read_at", null)
      .eq("user_id", user.id);
    qc.invalidateQueries({ queryKey: queryKeys.notifications.all() });
  };

  const markOne = async (id: string) => {
    await supabase
      .from("notifications" as any)
      .update({ read_at: new Date().toISOString() } as any)
      .eq("id", id);
    qc.invalidateQueries({ queryKey: queryKeys.notifications.all() });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-9 w-9 rounded-lg text-foreground/70 transition-colors duration-200 hover:text-foreground active:scale-95 data-[state=open]:bg-accent data-[state=open]:text-foreground"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell className="h-[18px] w-[18px]" />
          {unread > 0 && (
            <span className="absolute top-1 right-1 min-w-[17px] h-[17px] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center leading-none ring-2 ring-card animate-in zoom-in-50 duration-200">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-0">
        <div className="flex items-center justify-between p-3 border-b">
          <div className="text-sm font-semibold">Notifications</div>
          {unread > 0 && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={markAllRead}>
              <CheckCheck className="h-3.5 w-3.5 mr-1" /> Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {items.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              You're all caught up 🎉
            </div>
          )}
          {items.map((n) => {
            const to = n.link ?? "#";
            const unreadItem = !n.read_at;
            const Content = (
              <div
                className={cn(
                  "flex gap-2 p-3 border-b hover:bg-accent/40 transition-colors",
                  unreadItem && "bg-primary/5",
                )}
              >
                <div
                  className={cn(
                    "mt-1.5 h-2 w-2 rounded-full shrink-0",
                    unreadItem ? "bg-primary" : "bg-transparent",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{n.title}</div>
                  {n.body && (
                    <div className="text-xs text-muted-foreground line-clamp-2">{n.body}</div>
                  )}
                  <div className="text-[10px] text-muted-foreground mt-1">
                    {timeAgo(n.created_at)}
                  </div>
                </div>
              </div>
            );
            return to.startsWith("/") ? (
              <Link
                key={n.id}
                to={to}
                onClick={() => unreadItem && markOne(n.id)}
                className="block"
              >
                {Content}
              </Link>
            ) : (
              <div key={n.id} onClick={() => unreadItem && markOne(n.id)}>
                {Content}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
