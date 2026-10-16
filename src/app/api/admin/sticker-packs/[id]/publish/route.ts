import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idNumerique } from "@/lib/gestion/outils";
import { publierPack } from "@/lib/gestion/stickers";

/** POST — publie le pack (422 STICKER_PACK_INCOMPLETE avec `missing` s'il manque quelque chose). */
export const POST = routeAdmin("stickers.publish", async (_req, _s, ctx: { params: Promise<{ id: string }> }) =>
  okAdmin(await publierPack(idNumerique((await ctx.params).id, "STICKER_PACK_NOT_FOUND"))),
);
