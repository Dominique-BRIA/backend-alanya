import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idNumerique } from "@/lib/gestion/outils";
import { actionsSignalement, decider } from "@/lib/gestion/signalements";

type Ctx = { params: Promise<{ id: string }> };

/** GET — les décisions déjà prises sur ce signalement. */
export const GET = routeAdmin("reports.read", async (_req, _s, ctx: Ctx) =>
  okAdmin(await actionsSignalement(idNumerique((await ctx.params).id, "REPORT_NOT_FOUND"))),
);

/** POST — `{ action: reviewing|actioned|dismissed, note? }`. */
export const POST = routeAdmin("reports.handle", async (req, session, ctx: Ctx) =>
  okAdmin(await decider(idNumerique((await ctx.params).id, "REPORT_NOT_FOUND"), await req.json().catch(() => null), session)),
);
