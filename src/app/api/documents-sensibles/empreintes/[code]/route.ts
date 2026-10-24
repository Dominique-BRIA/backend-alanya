import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { rateLimit } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/documents-sensibles/empreintes/:code — ce que dit une EMPREINTE
 * NUMÉRIQUE (24/10/2026, demande du user).
 *
 * Toute copie d'un document sensible qui sort d'Alanya porte une empreinte (le
 * `code_trace` noté par POST …/consultations), écrite aux bords et dans ses
 * métadonnées. Saisie dans les Paramètres, elle rend : le geste, la date,
 * l'appareil, le compte qui a fait sortir la copie, et l'expéditeur du
 * document d'origine.
 *
 * Décision du user : TOUT compte connecté peut la consulter. L'adresse IP,
 * elle, reste en base et n'est jamais renvoyée.
 *
 * Le code se saisit en blocs (« 3F9A 0C1E … ») : espaces et casse sont
 * ignorés.
 */
export const GET = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const rl = await rateLimit(`empreinte:${userId}`, 30, 60_000);
  if (!rl.allowed) return fail("Trop de recherches", 429, "RATE_LIMITED");

  const { code: brut } = await ctx.params;
  const code = decodeURIComponent(brut ?? "").replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(code)) {
    return fail("Une empreinte compte 32 caractères (0-9, A-F)", 422, "EMPREINTE_INVALIDE");
  }

  const trace = await prisma.documentConsultation.findUnique({
    where: { codeTrace: code },
    select: {
      action: true,
      appareil: true,
      creeLe: true,
      mediaId: true,
      user: { select: { publicNumber: true, pseudo: true, nom: true } },
    },
  });
  if (!trace) return fail("Aucune copie ne porte cette empreinte", 404, "EMPREINTE_INCONNUE");

  // Le document d'origine : son déposant est l'expéditeur.
  const media = UUID.test(trace.mediaId)
    ? await prisma.mediaFile.findUnique({
        where: { id: trace.mediaId },
        select: { owner: { select: { publicNumber: true, pseudo: true, nom: true } } },
      })
    : null;

  const personne = (u: { publicNumber: string; pseudo: string | null; nom: string | null }) => ({
    alanyaId: u.publicNumber,
    nom: u.pseudo ?? u.nom ?? null,
  });

  return ok({
    empreinte: code,
    geste: trace.action,
    date: trace.creeLe.toISOString(),
    appareil: trace.appareil,
    utilisateur: personne(trace.user),
    expediteur: media ? personne(media.owner) : null,
  });
});
