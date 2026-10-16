import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idNumerique } from "@/lib/gestion/outils";
import { archiverPack } from "@/lib/gestion/stickers";

/** POST — archive le pack : il disparaît de l'application. */
export const POST = routeAdmin("stickers.publish", async (_req, _s, ctx: { params: Promise<{ id: string }> }) =>
  okAdmin(await archiverPack(idNumerique((await ctx.params).id, "STICKER_PACK_NOT_FOUND"))),
);
