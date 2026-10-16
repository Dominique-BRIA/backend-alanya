import { routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";
import { idNumerique } from "@/lib/gestion/outils";
import { televerser } from "@/lib/gestion/stickers";

/** POST — multipart : `files` (30 au plus, 1 Mo chacun), `emoji` facultatif. */
export const POST = routeAdmin("stickers.write", async (req, _s, ctx: { params: Promise<{ id: string }> }) => {
  const id = idNumerique((await ctx.params).id, "STICKER_PACK_NOT_FOUND");
  const form = await req.formData().catch(() => null);
  if (!form) throw new ErreurAdmin(400, "Envoi multipart attendu", "VALIDATION");
  return okAdmin({ stickers: await televerser(id, form) }, 201);
});
