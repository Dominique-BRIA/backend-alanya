import { fail, handleError } from "@/lib/http";
import { ErreurStickers } from "@/lib/stickers-utilisateur";

/** Les routes `/api/stickers/me…` : 204 sans corps, ou l'erreur du contrat. */
export async function repondre(action: () => Promise<unknown>): Promise<Response> {
  try {
    await action();
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof ErreurStickers) return fail(e.message, e.statut, e.code);
    return handleError(e);
  }
}
