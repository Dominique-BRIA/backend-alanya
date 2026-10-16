import { type NextRequest } from "next/server";
import { ok, fail, handleError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { rateLimit } from "@/lib/rate-limit";
import { ErreurAdmin } from "@/lib/gestion/reponses";
import { MOTIFS, signaler } from "@/lib/gestion/signalements";

/**
 * POST /api/signalements — un utilisateur signale un message ou un compte.
 *
 * Corps : `{ cible: "message"|"user", messageId?, userId?, motif, note?, extrait? }`.
 * Motifs : harassment, hate, violence, sexual, scam, spam, impersonation, other.
 * `extrait` ne sert que pour un message CHIFFRÉ : le serveur n'en a pas le texte.
 *
 * Les signalements sont triés dans la console de gestion. ⚠️ Route de
 * l'APPLICATION : format d'erreur ordinaire (`{ error: { message, code } }`).
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const quota = await rateLimit(`signalement:${userId}`, 20, 60 * 60_000);
    if (!quota.allowed) return fail("Trop de signalements, réessayez plus tard", 429, "RATE_LIMITED");
    return ok(await signaler(userId, await req.json().catch(() => null)), 201);
  } catch (e) {
    if (e instanceof ErreurAdmin) return fail(e.message, e.status, e.code);
    return handleError(e);
  }
});

/** GET /api/signalements — les motifs proposés, pour l'écran de l'application. */
export const GET = withAuth(async () => ok({ motifs: MOTIFS }));
