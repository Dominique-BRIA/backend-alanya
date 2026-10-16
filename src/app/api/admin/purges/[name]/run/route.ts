import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { lancerPurge } from "@/lib/gestion/purges";

/** POST /api/admin/purges/:name/run — lance la purge maintenant, et rend ses derniers passages. */
export const POST = routeAdmin("purges.run", async (_req, session, ctx: { params: Promise<{ name: string }> }) =>
  okAdmin(await lancerPurge((await ctx.params).name, session)),
);
