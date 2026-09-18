import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { accueilPourAppelant, enAbsence } from "@/lib/repondeur.mjs";

/**
 * LES MESSAGES D'ACCUEIL DU RÉPONDEUR.
 *
 * `GET  /api/repondeur`               → mes accueils, et l'état de l'interrupteur
 * `GET  /api/repondeur?appel=<id>`    → l'accueil ACTIF de la personne appelée
 * `POST /api/repondeur`               → ajouter un accueil, ou allumer/éteindre
 * `POST /api/repondeur?actif=<id>`    → désigner l'accueil actif
 * `POST /api/repondeur` `{minutes}`   → poser (ou lever) une absence
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

/**
 * L'ADRESSE PUBLIQUE D'UN MÉDIA — et non la colonne `url` telle quelle.
 *
 * 🐛 LES ACCUEILS NE SE JOUAIENT PAS. `MediaFile.url` est le CHEMIN DE STOCKAGE
 * (« uploads/2026/09/… »), pas une adresse servie : c'est `/api/media/<id>` qui
 * l'est, et c'est ce que construisent toutes les autres routes — les messages,
 * les statuts, l'API v1. Celle-ci rendait la colonne brute. Le client la
 * transformait donc en une adresse qui ne menait nulle part, la balise `<audio>`
 * échouait, et comme une balise `<audio>` échoue EN SILENCE, cliquer sur
 * « écouter » ne faisait rien du tout.
 *
 * ⚠️ LE MÊME DÉFAUT RENDAIT LE RÉPONDEUR MUET POUR L'APPELANT : `?appel=` sert
 * le même média. L'écran annonçait « Message d'accueil… » devant un haut-parleur
 * silencieux — un seul défaut, deux symptômes qui semblaient sans rapport.
 */
function mediaPublic<T extends { id: string }>(media: T): T {
  return { ...media, url: `/api/media/${media.id}` };
}

const ACCUEIL = {
  id: true,
  libelle: true,
  actif: true,
  createdAt: true,
  media: MEDIA,
} as const;

/** Durée maximale d'une absence : au-delà, ce n'est plus une absence. */
const ABSENCE_MAX_MINUTES = 24 * 60;

/**
 * L'état complet du répondeur, tel qu'il part au client.
 *
 * Un seul endroit le compose : les six retours de ce fichier rendaient la même
 * chose à la main, et le jour où un champ s'ajoute il en manque toujours un.
 */
async function etatRepondeur(userId: string) {
  const [moi, accueils] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { repondeurActif: true, repondeurJusquA: true },
    }),
    prisma.repondeurAccueil.findMany({
      where: { userId },
      // Le plus récent en tête : c'est celui qu'on vient d'enregistrer, donc
      // celui qu'on cherche.
      orderBy: { createdAt: "desc" },
      select: ACCUEIL,
    }),
  ]);
  return {
    actif: moi?.repondeurActif === 1,
    // ⚠️ RENDUE SEULEMENT SI ELLE EST ENCORE DEVANT NOUS : une date passée n'est
    // pas une absence, et l'écran afficherait « actif jusqu'à 9 h » à midi.
    jusquA: enAbsence(moi?.repondeurJusquA) ? moi?.repondeurJusquA : null,
    accueils: accueils.map(avecMediaPublic),
  };
}

/** Une ligne d'accueil dont le média porte son adresse servie. */
function avecMediaPublic<T extends { media: { id: string } }>(accueil: T): T {
  return { ...accueil, media: mediaPublic(accueil.media) };
}

/** Fenêtre pendant laquelle un appel donne droit à entendre l'accueil. */
const FENETRE_APPEL_MS = 10 * 60 * 1000;

/**
 * Ce compte a-t-il un accueil à faire entendre ?
 *
 * 🔴 ALLUMER UN RÉPONDEUR MUET EST LE PIÈGE QUI SE LIT COMME UNE PANNE. Depuis
 * que le répondeur COUPE LA SONNERIE, `accueilPourAppelant` ne rend quelque
 * chose que s'il a un accueil actif à servir : sans lui, il rend `null`, le
 * téléphone sonne comme avant, et l'utilisateur qui vient de cocher la case
 * conclut que la fonction ne marche pas. Elle marche — elle n'a simplement rien
 * à dire.
 *
 * On refuse donc l'allumage plutôt que de le servir à moitié. Le repli côté
 * appel reste le bon (mieux vaut sonner que servir un silence) ; c'est ICI
 * qu'il faut empêcher d'y tomber.
 */
async function aUnAccueil(userId: string) {
  const accueil = await prisma.repondeurAccueil.findFirst({
    where: { userId, actif: 1 },
    select: { id: true },
  });
  return accueil !== null;
}

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

    // ⚠️ LA REGLE VIT DANS `@/lib/repondeur.mjs` ET NON ICI : `ws-server.mjs` se
    // pose exactement la même question, avant de faire sonner. Deux copies se
    // contrediraient le jour où l'une des deux évoluerait seule.
    const accueil = await accueilPourAppelant(prisma, cibleId);
    if (!accueil) return fail("Aucun répondeur pour cet appel", 404, "NOT_FOUND");
    return ok({ accueil: accueil.media, absence: accueil.absence });
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
  return ok({ actif: moi?.repondeurActif === 1, accueils: accueils.map(avecMediaPublic) });
});

/**
 * Ajoute un accueil, en désigne un, allume l'interrupteur, ou pose une absence.
 *
 * Corps possibles, indépendants :
 *   `{ "mediaId": "…", "libelle": "Congés" }` → ajoute, et l'active
 *   `{ "actif": true | false }`               → allume ou éteint le répondeur
 *   `{ "absenceMinutes": 90 }`                → absence de 90 min (0 = lever)
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
     * compte SANS aucun accueil désigné — un répondeur muet qui se déclare prêt.
     */
    await prisma.$transaction([
      prisma.repondeurAccueil.updateMany({
        where: { userId, actif: 1 },
        data: { actif: 0 },
      }),
      prisma.repondeurAccueil.update({ where: { id: choisi }, data: { actif: 1 } }),
    ]);
    return ok(await etatRepondeur(userId));
  }

  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return fail("Corps JSON invalide", 400, "BAD_JSON");
  }
  const recu = (corps ?? {}) as {
    mediaId?: unknown;
    libelle?: unknown;
    actif?: unknown;
    absenceMinutes?: unknown;
  };

  // ── Poser ou lever une absence ────────────────────────────────────────
  if ("absenceMinutes" in recu) {
    const minutes = recu.absenceMinutes;
    if (typeof minutes !== "number" || !Number.isFinite(minutes)) {
      return fail("« absenceMinutes » doit être un nombre", 400, "BAD_BODY");
    }
    /*
     * ⚠️ LA BORNE EST ICI, ET NON SEULEMENT DANS L'ÉCRAN. Une absence de mille
     * heures n'est plus une absence : c'est un compte devenu injoignable dont
     * personne ne se souvient, et l'écran qui l'aurait posée n'est pas le seul
     * chemin vers cette route.
     */
    if (minutes < 0 || minutes > ABSENCE_MAX_MINUTES) {
      return fail(`« absenceMinutes » doit aller de 0 à ${ABSENCE_MAX_MINUTES}`, 400, "BAD_BODY");
    }
    // ⚠️ SEULEMENT QUAND ON EN POSE UNE : lever une absence (`0`) doit rester
    // possible même sans accueil, sans quoi un compte resterait coincé.
    if (minutes > 0 && !(await aUnAccueil(userId))) {
      return fail(
        "Enregistrez d'abord un message d'accueil : sans lui, les appels sonneraient comme d'habitude.",
        400,
        "NO_GREETING",
      );
    }
    await prisma.user.update({
      where: { id: userId },
      data: {
        // 0 lève l'absence. On efface au lieu de poser une date passée : une
        // colonne vide se lit sans calcul, et l'index partiel s'allège d'autant.
        repondeurJusquA: minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null,
        // Poser une absence allume le répondeur : demander qu'on réponde à sa
        // place en laissant l'interrupteur éteint n'aurait aucun sens, et le
        // retour au mode par défaut trouverait le répondeur inerte.
        ...(minutes > 0 ? { repondeurActif: 1 } : {}),
      },
    });
    return ok(await etatRepondeur(userId));
  }

  // ── Allumer ou éteindre le répondeur ──────────────────────────────────
  if ("actif" in recu && !("mediaId" in recu)) {
    if (typeof recu.actif !== "boolean") {
      return fail("« actif » doit être un booléen", 400, "BAD_BODY");
    }
    // ⚠️ SEULEMENT À L'ALLUMAGE. Éteindre doit toujours passer : refuser
    // d'éteindre un répondeur sans accueil enfermerait le compte.
    if (recu.actif && !(await aUnAccueil(userId))) {
      return fail(
        "Enregistrez d'abord un message d'accueil : sans lui, les appels sonneraient comme d'habitude.",
        400,
        "NO_GREETING",
      );
    }
    await prisma.user.update({
      where: { id: userId },
      data: {
        repondeurActif: recu.actif ? 1 : 0,
        /*
         * ⚠️ ÉTEINDRE ÉTEINT TOUT, ABSENCE COMPRISE. L'absence passe outre
         * l'interrupteur — c'est voulu, poser une absence est une demande plus
         * récente et plus explicite qu'une case cochée. Mais alors un
         * interrupteur éteint pendant une absence ne changeait RIEN : les appels
         * continuaient d'aller au répondeur, et plus rien à l'écran ne disait
         * pourquoi. « Éteint » doit vouloir dire éteint.
         */
        ...(recu.actif ? {} : { repondeurJusquA: null }),
      },
    });
  return ok(await etatRepondeur(userId));
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
  return ok(await etatRepondeur(userId), 201);
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
  return ok(await etatRepondeur(userId));
});
