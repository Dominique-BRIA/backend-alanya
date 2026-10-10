import { type NextRequest } from "next/server";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { envoiDuProprietaire } from "@/modules/media/envois-morceaux";
import { programmerPublication } from "@/modules/media/publication-differee";

/**
 * POST /api/media/envois/:id/publication — confie au serveur le message à
 * publier quand le fichier aura fini d'arriver. Voir
 * `src/modules/media/publication-differee.ts`.
 *
 * Corps : `{ convId, type, messageId, replyToId?, vueUnique?, deviceId,
 * enveloppes }` dans un fil chiffré à deux ; `{ …, groupe }` dans un groupe
 * chiffré.
 *
 * ⚠️ LE JETON D'ACCÈS, PAS LE JETON D'ENVOI. Programmer un message, c'est
 * parler au nom du compte : ce geste se fait au premier plan, par
 * l'utilisateur. Le jeton d'envoi ne sert qu'à pousser des octets.
 */
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;
  const envoi = await envoiDuProprietaire(id, userId);
  return ok(await programmerPublication(envoi, userId, await req.json().catch(() => null)));
});
