import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { reglerPurge } from "@/lib/gestion/purges";

/** PUT /api/admin/purges/:name — `{ enabled?, overrides? }` (une surcharge à null revient au défaut). */
export const PUT = routeAdmin("purges.settings", async (req, session, ctx: { params: Promise<{ name: string }> }) =>
  okAdmin(await reglerPurge((await ctx.params).name, await req.json().catch(() => null), session)),
);
