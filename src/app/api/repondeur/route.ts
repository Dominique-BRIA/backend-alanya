import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

/**
 * LE MESSAGE D'ACCUEIL DU RÉPONDEUR.
 *
 * `GET  /api/repondeur`              → le mien
 * `GET  /api/repondeur?appel=<id>`   → celui de la personne que j'appelle
 * `POST /api/repondeur`              → poser un accueil, l'activer, le couper
 * `DELETE /api/repondeur`            → le retirer
 *
 * 🔴 LE RÉPONDEUR EST JOUÉ PAR LE CLIENT DE L'APPELANT, faute de quoi il
 * faudrait un serveur média. Les appels sont en pair-à-pair : quand personne ne
 * décroche, il n'existe AUCUN pair pour jouer l'accueil et enregistrer. À
 * l'expiration de la sonnerie, l'application de l'appelant télécharge donc
 * l'accueil du destinataire, le joue, et lui propose d'enregistrer.
 *
 * ⚠️ C'EST POURQUOI `?appel=` EXISTE ET EST GARDÉ. Sans contrôle, cette route
 * laisserait n'importe qui moissonner la voix de n'importe qui : il suffirait de
 * demander l'accueil de chaque compte. On ne le sert donc qu'à quelqu'un qui a
 * RÉELLEMENT un appel en cours ou récent vers cette personne, resté sans
 * réponse.
 */

/** Un accueil n'a de sens que s'il est actif ET qu'un média le porte. */
const SELECTION = {
  repondeurActif: true,
  repondeurMediaId: true,
  repondeurMedia: {
    select: { id: true, url: true, mimeType: true, durationMs: true, filename: true },
  },
} as const;

/**
 * Un appel récent me donne-t-il le droit d'entendre l'accueil de sa cible ?
 *
 * ⚠️ QUATRE CONDITIONS, ET AUCUNE N'EST DÉCORATIVE :
 *   - l'appel existe et je l'ai INITIÉ — sinon j'écouterais l'accueil de
 *     quelqu'un que je n'ai jamais appelé ;
 *   - il n'a PAS été décroché — un appel abouti n'a rien à faire avec un
 *     répondeur ;
 *   - il est RÉCENT — sans quoi un identifiant d'appel vieux de six mois
 *     resterait un laissez-passer permanent ;
 *   - la cible a bien ACTIVÉ son répondeur.
 */
const FENETRE_APPEL_MS = 10 * 60 * 1000;

async function cibleAutorisee(callId: string, userId: string) {
  const appel = await prisma.call.findUnique({
    where: { id: callId },
    select: {
      initiatorId: true,
      answeredAt: true,
      startedAt: true,
      participants: { select: { userId: true } },
    },
  });
  if (!appel) return null;
  if (appel.initiatorId !== userId) return null;
  if (appel.answeredAt !== null) return null;
  if (Date.now() - appel.startedAt.getTime() > FENETRE_APPEL_MS) return null;

  // Le destinataire : le seul participant qui ne soit pas moi. En appel de
  // groupe il y en a plusieurs — un répondeur n'y a pas de sens, on renonce.
  const autres = appel.participants
    .map((p) => p.userId)
    .filter((id) => id !== userId);
  return autres.length === 1 ? autres[0] : null;
}

export const GET = withAuth(async (req: NextRequest, userId: string) => {
  const callId = req.nextUrl.searchParams.get("appel");

  if (callId !== null) {
    const cibleId = await cibleAutorisee(callId, userId);
    // ⚠️ 404 ET NON 403 : distinguer les deux apprendrait à un curieux que le
    // compte existe et qu'il a un accueil. « Il n'y a rien ici » suffit.
    if (!cibleId) return fail("Aucun répondeur pour cet appel", 404, "NOT_FOUND");

    const cible = await prisma.user.findUnique({
      where: { id: cibleId },
      select: SELECTION,
    });
    if (!cible || cible.repondeurActif !== 1 || !cible.repondeurMedia) {
      return fail("Aucun répondeur pour cet appel", 404, "NOT_FOUND");
    }
    return ok({ accueil: cible.repondeurMedia });
  }

  const moi = await prisma.user.findUnique({ where: { id: userId }, select: SELECTION });
  return ok({
    actif: moi?.repondeurActif === 1,
    accueil: moi?.repondeurMedia ?? null,
  });
});

/**
 * Pose un accueil, l'active ou le coupe. Les deux champs sont indépendants et
 * facultatifs : `{ "mediaId": "…" }`, `{ "actif": true }`, ou les deux.
 *
 * ⚠️ `mediaId` DOIT M'APPARTENIR. Sans ce contrôle, on poserait comme accueil le
 * fichier de n'importe qui — une photo reçue, l'enregistrement d'un autre — et
 * on le ferait jouer à ses correspondants.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return fail("Corps JSON invalide", 400, "BAD_JSON");
  }
  const recu = (corps ?? {}) as { mediaId?: unknown; actif?: unknown };
  const data: { repondeurMediaId?: string; repondeurActif?: number } = {};

  if ("mediaId" in recu) {
    if (typeof recu.mediaId !== "string" || recu.mediaId.trim() === "") {
      return fail("« mediaId » doit être un identifiant de média", 400, "BAD_BODY");
    }
    const media = await prisma.mediaFile.findUnique({
      where: { id: recu.mediaId },
      select: { ownerId: true, mimeType: true },
    });
    if (!media || media.ownerId !== userId) {
      return fail("Média introuvable", 404, "NOT_FOUND");
    }
    // ⚠️ UN ACCUEIL EST UN SON. Accepter une image poserait un accueil que
    // personne ne pourrait entendre, et l'écran promettrait un répondeur muet.
    if (!media.mimeType.startsWith("audio/") && !media.mimeType.startsWith("video/")) {
      return fail("Le message d'accueil doit être un fichier audio", 400, "BAD_MEDIA");
    }
    data.repondeurMediaId = recu.mediaId;
  }

  if ("actif" in recu) {
    if (typeof recu.actif !== "boolean") {
      return fail("« actif » doit être un booléen", 400, "BAD_BODY");
    }
    data.repondeurActif = recu.actif ? 1 : 0;
  }

  if (Object.keys(data).length === 0) {
    return fail("Aucun réglage fourni", 400, "BAD_BODY");
  }

  /*
   * ⚠️ POSER UN ACCUEIL L'ACTIVE, sauf refus explicite dans la même requête.
   *
   * Enregistrer son message puis devoir chercher un interrupteur pour qu'il
   * serve est exactement le genre d'étape qu'on oublie — et le répondeur
   * resterait muet sans que rien ne dise pourquoi.
   */
  if (data.repondeurMediaId && data.repondeurActif === undefined) {
    data.repondeurActif = 1;
  }

  const maj = await prisma.user.update({
    where: { id: userId },
    data,
    select: SELECTION,
  });
  return ok({ actif: maj.repondeurActif === 1, accueil: maj.repondeurMedia ?? null });
});

/**
 * Retire l'accueil, et éteint le répondeur par la même occasion.
 *
 * ⚠️ LE MÉDIA N'EST PAS SUPPRIMÉ ICI. Le fichier appartient au compte et peut
 * avoir été partagé ailleurs ; le supprimer d'autorité casserait ces usages. On
 * détache, la suppression du fichier reste un geste à part.
 */
export const DELETE = withAuth(async (_req: NextRequest, userId: string) => {
  await prisma.user.update({
    where: { id: userId },
    data: { repondeurMediaId: null, repondeurActif: 0 },
  });
  return new Response(null, { status: 204 });
});
