import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { rateLimit } from "@/lib/rate-limit";
import { assertParticipant } from "@/modules/messaging/access";
import { deposerMessageSysteme, nomPourAvis } from "@/lib/messages-systeme";

/**
 * POST /api/conversations/:id/capture — « X a fait une capture d'écran ».
 *
 * Demande du user (29/10/2026) : dans un groupe comme à deux, une capture
 * d'écran prise dans la conversation — ou dans un fichier ouvert depuis elle —
 * est signalée à tous. C'est l'appareil qui la détecte (Android) et qui
 * l'annonce ici ; le serveur dépose un avis système, composé par chaque client
 * dans la langue du lecteur.
 *
 * ⚠️ UNE PAR DIX SECONDES ET PAR CONVERSATION : trois captures enchaînées ne
 * doivent pas remplir le fil de trois avis identiques.
 */
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  await assertParticipant(convId, userId);

  const rl = await rateLimit(`capture:${userId}:${convId}`, 1, 10_000);
  if (!rl.allowed) return ok({ depose: false });

  try {
    await deposerMessageSysteme(convId, userId, "capture_ecran", {
      actor: await nomPourAvis(userId),
    });
  } catch {
    return fail("Avis de capture impossible", 500, "CAPTURE_ECHEC");
  }
  return ok({ depose: true });
});
