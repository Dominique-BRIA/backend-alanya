import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idNumerique } from "@/lib/gestion/outils";
import { modifierSticker, supprimerSticker } from "@/lib/gestion/stickers";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH — `{ emoji?, position?, name_i18n? }`. */
export const PATCH = routeAdmin("stickers.write", async (req, _s, ctx: Ctx) => {
  await modifierSticker(idNumerique((await ctx.params).id, "STICKER_NOT_FOUND"), await req.json().catch(() => null));
  return okAdmin({ ok: true });
});

export const DELETE = routeAdmin("stickers.write", async (_req, _s, ctx: Ctx) => {
  await supprimerSticker(idNumerique((await ctx.params).id, "STICKER_NOT_FOUND"));
  return okAdmin({ ok: true });
});
