import { routeAdmin } from "@/lib/gestion/session";
import { periode, reponseCsv } from "@/lib/gestion/outils";
import { analyses } from "@/lib/gestion/statistiques";

/** GET /api/admin/analytics/export?from&to — l'activité jour par jour, en CSV. */
export const GET = routeAdmin("analytics.export", async (req) => {
  const p = periode(req.nextUrl.searchParams);
  const a = await analyses(p);
  return reponseCsv(
    `analyses-${p.from.toISOString().slice(0, 10)}-${p.to.toISOString().slice(0, 10)}.csv`,
    ["date", "messages", "appels_audio", "appels_video"],
    a.messagesByDay.map((j, i) => [j.date, j.count, a.callsByDay[i]?.audio ?? 0, a.callsByDay[i]?.video ?? 0]),
  );
});
