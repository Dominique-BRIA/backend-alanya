import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idNumerique } from "@/lib/gestion/outils";
import { detailPack, modifierPack } from "@/lib/gestion/stickers";

type Ctx = { params: Promise<{ id: string }> };

export const GET = routeAdmin("stickers.read", async (_req, _s, ctx: Ctx) =>
  okAdmin(await detailPack(idNumerique((await ctx.params).id, "STICKER_PACK_NOT_FOUND"))),
);

/** PATCH — nom, description, auteur, premium, ordre, vignette (`cover_sticker_id`). */
export const PATCH = routeAdmin("stickers.write", async (req, _s, ctx: Ctx) => {
  await modifierPack(idNumerique((await ctx.params).id, "STICKER_PACK_NOT_FOUND"), await req.json().catch(() => null));
  return okAdmin({ ok: true });
});
