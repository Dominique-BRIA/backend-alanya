import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

/**
 * LES MESSAGES D'ACCUEIL DU RÉPONDEUR.
 *
 * `GET  /api/repondeur`               → mes accueils, et l'état de l'interrupteur
 * `GET  /api/repondeur?appel=<id>`    → l'accueil ACTIF de la personne appelée
 * `POST /api/repondeur`               → ajouter un accueil, ou allumer/éteindre
 * `POST /api/repondeur?actif=<id>`    → désigner l'accueil actif
 * `DELETE /api/repondeur?accueil=<id>` → retirer un accueil
 *
 * 🔴 LE RÉPONDEUR EST JOUÉ PAR LE CLIENT DE L'APPELANT, faute de quoi il
 * faudrait un serveur média : les appels sont en pair-à-pair, et quand personne
 * ne décroche il n'existe AUCUN pair pour jouer l'accueil et enregistrer.
 *
 * ⚠️ C'EST POURQUOI `?appel=` EXISTE ET EST GARDÉ. Sans contrôle, cette route
 * laisserait n'importe qui moissonner la voix de n'importe qui : il suffirait de
 * la demander compte par compte. On ne la sert donc qu'à quelqu'un qui a
 * RÉELLEMENT un appel récent vers cette personne, resté sans réponse.
 */

const MEDIA = {
  select: { id: true, url: true, mimeType: true, durationMs: true, filename: true },
} as const;

const ACCUEIL = {
  id: true,
  libelle: true,
  actif: true,
  createdAt: true,
  media: MEDIA,
} as const;

/** Fenêtre pendant laquelle un appel donne droit à entendre l'accueil. */
const FENETRE_APPEL_MS = 10 * 60 * 1000;

/**
 * Un appel récent me donne-t-il le droit d'entendre l'accueil de sa cible ?
 *
 * ⚠️ QUATRE CONDITIONS, ET AUCUNE N'EST DÉCORATIVE : l'appel existe et je l'ai
 * INITIÉ ; il n'a PAS été décroché ; il est RÉCENT — sans quoi un identifiant
 * vieux de six mois resterait un laissez-passer ; et il ne vise qu'UNE personne,
 * un appel de groupe n'ayant pas de répondeur.
 */
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

  const autres = appel.participants.map((p) => p.userId).filter((id) => id !== userId);
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
      select: { repondeurActif: true },
    });
    if (cible?.repondeurActif !== 1) {
      return fail("Aucun répondeur pour cet appel", 404, "NOT_FOUND");
    }
    const accueil = await prisma.repondeurAccueil.findFirst({
      where: { userId: cibleId, actif: 1 },
      select: { media: MEDIA },
    });
    if (!accueil) return fail("Aucun répondeur pour cet appel", 404, "NOT_FOUND");
    return ok({ accueil: accueil.media });
  }

  const [moi, accueils] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { repondeurActif: true } }),
    prisma.repondeurAccueil.findMany({
      where: { userId },
      // Le plus récent en tête : c'est celui qu'on vient d'enregistrer, donc
      // celui qu'on cherche.
      orderBy: { createdAt: "desc" },
      select: ACCUEIL,
    }),
  ]);
  return ok({ actif: moi?.repondeurActif === 1, accueils });
});

/**
 * Ajoute un accueil, en désigne un comme actif, ou allume l'interrupteur.
 *
 * Corps possibles, indépendants :
 *   `{ "mediaId": "…", "libelle": "Congés" }` → ajoute, et l'active
 *   `{ "actif": true | false }`               → allume ou éteint le répondeur
 * Ou `?actif=<idAccueil>`                     → désigne celui qu'on entend
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const choisi = req.nextUrl.searchParams.get("actif");

  // ── Désigner l'accueil actif ──────────────────────────────────────────
  if (choisi !== null) {
    const accueil = await prisma.repondeurAccueil.findUnique({
      where: { id: choisi },
      select: { userId: true },
    });
    if (!accueil || accueil.userId !== userId) {
      return fail("Accueil introuvable", 404, "NOT_FOUND");
    }
    /*
     * ⚠️ ÉTEINDRE LES AUTRES D'ABORD, ET DANS LA MÊME TRANSACTION.
     *
     * L'index unique partiel refuse deux actifs : allumer avant d'éteindre
     * échouerait. Et sans transaction, une panne entre les deux laisserait le
     * compte SANS aucun accueil actif — un répondeur muet qui se déclare prêt.
     */
    await prisma.$transaction([
      prisma.repondeurAccueil.updateMany({
        where: { userId, actif: 1 },
        data: { actif: 0 },
      }),
      prisma.repondeurAccueil.update({ where: { id: choisi }, data: { actif: 1 } }),
    ]);
    const accueils = await prisma.repondeurAccueil.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: ACCUEIL,
    });
    const moi = await prisma.user.findUnique({
      where: { id: userId },
      select: { repondeurActif: true },
    });
    return ok({ actif: moi?.repondeurActif === 1, accueils });
  }

  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return fail("Corps JSON invalide", 400, "BAD_JSON");
  }
  const recu = (corps ?? {}) as { mediaId?: unknown; libelle?: unknown; actif?: unknown };

  // ── Allumer ou éteindre le répondeur ──────────────────────────────────
  if ("actif" in recu && !("mediaId" in recu)) {
    if (typeof recu.actif !== "boolean") {
      return fail("« actif » doit être un booléen", 400, "BAD_BODY");
    }
    await prisma.user.update({
      where: { id: userId },
      data: { repondeurActif: recu.actif ? 1 : 0 },
    });
    const accueils = await prisma.repondeurAccueil.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: ACCUEIL,
    });
    return ok({ actif: recu.actif, accueils });
  }

  // ── Ajouter un accueil ────────────────────────────────────────────────
  if (typeof recu.mediaId !== "string" || recu.mediaId.trim() === "") {
    return fail("« mediaId » doit être un identifiant de média", 400, "BAD_BODY");
  }
  const media = await prisma.mediaFile.findUnique({
    where: { id: recu.mediaId },
    select: { ownerId: true, mimeType: true },
  });
  // ⚠️ LE MÉDIA DOIT M'APPARTENIR : sans ce contrôle, on poserait comme accueil
  // le fichier de n'importe qui — une photo reçue, l'enregistrement d'un autre —
  // et on le ferait jouer à ses correspondants.
  if (!media || media.ownerId !== userId) {
    return fail("Média introuvable", 404, "NOT_FOUND");
  }
  if (!media.mimeType.startsWith("audio/") && !media.mimeType.startsWith("video/")) {
    return fail("Le message d'accueil doit être un fichier audio", 400, "BAD_MEDIA");
  }

  const libelle =
    typeof recu.libelle === "string" && recu.libelle.trim() !== ""
      ? recu.libelle.trim().slice(0, 60)
      : null;

  /*
   * ⚠️ LE NOUVEL ACCUEIL DEVIENT L'ACTIF, et le répondeur s'allume avec lui.
   *
   * Enregistrer son message puis devoir le désigner, puis chercher un
   * interrupteur, fait trois étapes dont deux s'oublient — et le répondeur
   * resterait muet sans que rien ne dise pourquoi. Celui qui veut garder
   * l'ancien actif n'a qu'à le redésigner, ce qui est un geste explicite.
   */
  await prisma.$transaction([
    prisma.repondeurAccueil.updateMany({ where: { userId, actif: 1 }, data: { actif: 0 } }),
    prisma.repondeurAccueil.create({
      data: { userId, mediaId: recu.mediaId, libelle, actif: 1 },
    }),
    prisma.user.update({ where: { id: userId }, data: { repondeurActif: 1 } }),
  ]);

  const accueils = await prisma.repondeurAccueil.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: ACCUEIL,
  });
  return ok({ actif: true, accueils }, 201);
});

/**
 * Retire UN accueil, désigné par `?accueil=<id>`.
 *
 * ⚠️ RETIRER L'ACTIF ÉTEINT LE RÉPONDEUR. Le laisser allumé sans accueil
 * promettrait aux appelants un message que personne n'a enregistré : ils
 * tomberaient sur un répondeur muet, ce qui est pire qu'un appel manqué.
 */
export const DELETE = withAuth(async (req: NextRequest, userId: string) => {
  const id = req.nextUrl.searchParams.get("accueil");
  if (!id) return fail("« accueil » est requis", 400, "BAD_BODY");

  const accueil = await prisma.repondeurAccueil.findUnique({
    where: { id },
    select: { userId: true, actif: true },
  });
  if (!accueil || accueil.userId !== userId) {
    return fail("Accueil introuvable", 404, "NOT_FOUND");
  }

  await prisma.repondeurAccueil.delete({ where: { id } });

  if (accueil.actif === 1) {
    await prisma.user.update({ where: { id: userId }, data: { repondeurActif: 0 } });
  }

  const accueils = await prisma.repondeurAccueil.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: ACCUEIL,
  });
  const moi = await prisma.user.findUnique({
    where: { id: userId },
    select: { repondeurActif: true },
  });
  return ok({ actif: moi?.repondeurActif === 1, accueils });
});
