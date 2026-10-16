import { type NextRequest } from "next/server";
import { ok, fail, handleError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { ErreurAdmin } from "@/lib/gestion/reponses";
import { demanderVerification, etatVerification } from "@/lib/gestion/verifications";

/**
 * Le badge « vérifié », côté APPLICATION (format d'erreur ordinaire).
 *
 * GET  /api/verification — où en est mon badge, et ma dernière demande.
 * POST /api/verification — `{ nom, documents: [{ type: 1|4, mediaId }] }` :
 *      demande le badge avec des pièces déjà téléversées (`POST /api/media`).
 *      Une demande en attente de pièce est complétée, pas dupliquée.
 */
export const GET = withAuth(async (_req: NextRequest, userId: string) => ok(await etatVerification(userId)));

export const POST = withAuth(async (req: NextRequest, userId: string) => {
  try {
    return ok(await demanderVerification(userId, await req.json().catch(() => null)), 201);
  } catch (e) {
    if (e instanceof ErreurAdmin) return fail(e.message, e.status, e.code);
    return handleError(e);
  }
});
