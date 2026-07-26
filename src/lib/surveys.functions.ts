/**
 * Satisfaction survey analytics.
 * Reads from public.satisfaction_surveys within a date window.
 * Empty until surveys are recorded.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const surveyStatsInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  agentId: z.string().uuid().nullable().optional(),
});

export const getSurveyAnalytics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => surveyStatsInput.parse(d))
  .handler(async ({ context, data }) => {
    const { supabase } = context as { supabase: any };
    const start = `${data.from}T00:00:00Z`;
    const end = `${data.to}T23:59:59Z`;
    let q = supabase
      .from("satisfaction_surveys")
      .select("id,rating,agent_id,submitted_at,call_id")
      .gte("submitted_at", start)
      .lte("submitted_at", end);
    if (data.agentId) q = q.eq("agent_id", data.agentId);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const list = (rows as any[]) ?? [];
    const total = list.length;
    const avg = total ? list.reduce((s, r) => s + Number(r.rating || 0), 0) / total : 0;
    const distribution = [1, 2, 3, 4, 5].map((n) => ({
      rating: n,
      count: list.filter((r) => r.rating === n).length,
    }));
    const byDayMap = new Map<string, { date: string; count: number; sum: number }>();
    for (const r of list) {
      const date = String(r.submitted_at).slice(0, 10);
      const b = byDayMap.get(date) ?? { date, count: 0, sum: 0 };
      b.count++;
      b.sum += Number(r.rating || 0);
      byDayMap.set(date, b);
    }
    const trend = [...byDayMap.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((b) => ({
        date: b.date,
        count: b.count,
        avg: b.count ? b.sum / b.count : 0,
      }));

    return {
      ok: true as const,
      total,
      avg,
      distribution,
      trend,
    };
  });
