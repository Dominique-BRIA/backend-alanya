/**
 * MESSAGES À VUE UNIQUE — photo, vidéo ou vocal qu'on n'ouvre qu'une fois.
 *
 * Demandé le 02/10/2026 (« comme dans WhatsApp »). Le cycle complet :
 *
 *   1. ENVOI : le message porte `vueUnique`, un seul média, aucune légende ;
 *   2. OUVERTURE : le destinataire demande l'accès (`ouvrirVueUnique`). Une
 *      ligne `message_ouverture` est écrite — c'est elle qui fait l'unicité —
 *      et la route des médias le sert pendant une FENÊTRE courte ;
 *   3. FERMETURE : le visionneur refermé (`fermerVueUnique`), ou la fenêtre
 *      écoulée, l'accès est clos pour cette personne ;
 *   4. EFFACEMENT : quand TOUS les destinataires ont ouvert et refermé, le
 *      fichier est effacé du stockage pour de bon (toutes versions B2), et sa
 *      ligne `media_files` disparaît. Un média jamais ouvert part au bout de
 *      14 jours, comme sur WhatsApp.
 *
 * 🔴 L'EXPÉDITEUR NE PEUT PAS ROUVRIR SON ENVOI. Tous ses appareils voient
 * « Photo · vue unique », jamais l'image. C'est le contrat de WhatsApp : ce
 * que l'on montre une fois ne se retrouve plus nulle part, pas même chez soi.
 *
 * ⚠️ CE QUE LE SERVEUR NE PEUT PAS GARANTIR : une photo de l'écran prise avec
 * un autre téléphone. Android bloque la capture pendant l'affichage
 * (FLAG_SECURE) ; le reste relève de la confiance, comme partout.
 */
import { prisma } from "@/lib/prisma";
import { previensDesPersonnes } from "@/lib/salle-temps-reel";
import { effacerDefinitivement } from "@/modules/media/storage";

/** Les types qui peuvent partir à vue unique. */
export const TYPES_VUE_UNIQUE = new Set(["IMAGE", "VIDEO", "AUDIO"]);

/**
 * LA FENÊTRE D'OUVERTURE : le temps pendant lequel le média reste servi au
 * destinataire qui l'a ouvert.
 *
 * ⚠️ PAS « AUSSI LONGTEMPS QUE LE VISIONNEUR EST OUVERT » : une application
 * tuée ne dira jamais qu'elle a refermé, et l'accès resterait ouvert pour
 * toujours. Cinq minutes couvrent un vocal ou une vidéo de quelques minutes,
 * un réseau lent et une reprise après un appel entrant.
 */
export const FENETRE_OUVERTURE_MS = 5 * 60 * 1000;

/** Un média jamais ouvert est effacé au bout de ce délai (WhatsApp : 14 jours). */
export const DELAI_ABANDON_MS = 14 * 24 * 60 * 60 * 1000;

/** Une ouverture est CLOSE : visionneur refermé, ou fenêtre écoulée. */
export function ouvertureClose(o: { ouvertA: Date; fermeA: Date | null }, maintenant = new Date()) {
  return o.fermeA !== null || maintenant.getTime() - o.ouvertA.getTime() > FENETRE_OUVERTURE_MS;
}

/**
 * Le média d'un message à vue unique est-il servi à `userId`, maintenant ?
 *
 * Oui seulement pour un DESTINATAIRE dont l'ouverture est en cours. Ni
 * l'expéditeur, ni un destinataire qui n'a pas encore demandé l'accès — une
 * vignette chargée d'avance serait déjà une vue — ni celui qui a refermé.
 */
export async function vueUniqueServie(messageId: string, senderId: string, userId: string) {
  if (userId === senderId) return false;
  const o = await prisma.messageOuverture.findUnique({
    where: { messageId_userId: { messageId, userId } },
  });
  return o !== null && !ouvertureClose(o);
}

export type ResultatOuverture =
  | {
      ok: true;
      media: { id: string; url: string; mimeType: string; sizeBytes: number; durationMs: number | null }[];
      fenetreSecondes: number;
    }
  | { ok: false; code: "INTROUVABLE" | "EXPEDITEUR" | "DEJA_OUVERTE" | "EFFACEE" };

/**
 * Ouvre un message à vue unique pour `userId`.
 *
 * ⚠️ UNE OUVERTURE EN COURS PEUT ÊTRE REPRISE (même personne, fenêtre non
 * écoulée, visionneur pas refermé) : un réseau qui coupe pendant le
 * téléchargement ne doit pas faire perdre la photo. Une ouverture CLOSE, non.
 *
 * ⚠️ L'ÉCRITURE PASSE PAR LA CLÉ PRIMAIRE : deux appareils qui ouvrent à la
 * même milliseconde n'écrivent qu'une ligne, et le second reprend la même
 * ouverture au lieu d'en créer une seconde.
 */
export async function ouvrirVueUnique(messageId: string, userId: string): Promise<ResultatOuverture> {
  const message = await prisma.message.findFirst({
    where: {
      id: messageId,
      vueUnique: true,
      deletedAt: null,
      conv: { participants: { some: { userId } } },
    },
    select: {
      id: true,
      convId: true,
      senderId: true,
      media: { select: { id: true, mimeType: true, sizeBytes: true, durationMs: true } },
    },
  });
  if (!message) return { ok: false, code: "INTROUVABLE" };
  if (message.senderId === userId) return { ok: false, code: "EXPEDITEUR" };

  const existante = await prisma.messageOuverture.findUnique({
    where: { messageId_userId: { messageId, userId } },
  });
  if (existante && ouvertureClose(existante)) return { ok: false, code: "DEJA_OUVERTE" };
  if (message.media.length === 0) return { ok: false, code: "EFFACEE" };

  if (!existante) {
    await prisma.messageOuverture.upsert({
      where: { messageId_userId: { messageId, userId } },
      create: { messageId, userId },
      update: {},
    });
    await annoncer(message.convId, messageId, userId, "vue_unique_ouverte");
  }

  return {
    ok: true,
    media: message.media.map((f) => ({
      id: f.id,
      url: `/api/media/${f.id}`,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      durationMs: f.durationMs,
    })),
    fenetreSecondes: Math.floor(FENETRE_OUVERTURE_MS / 1000),
  };
}

/** Le visionneur est refermé : l'accès se clôt, et le fichier part si tous ont vu. */
export async function fermerVueUnique(messageId: string, userId: string): Promise<void> {
  await prisma.messageOuverture.updateMany({
    where: { messageId, userId, fermeA: null },
    data: { fermeA: new Date() },
  });
  await tenterEffacement(messageId);
}

/**
 * Efface le fichier d'un message à vue unique SI son heure est venue : tous
 * les destinataires ont une ouverture close, ou le message a 14 jours.
 *
 * Rend `true` si un effacement a eu lieu. Ne lève pas : une panne du
 * stockage laisse la ligne en place, et la purge suivante réessaie.
 */
export async function tenterEffacement(messageId: string, maintenant = new Date()): Promise<boolean> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      convId: true,
      senderId: true,
      vueUnique: true,
      createdAt: true,
      deletedAt: true,
      expiresAt: true,
      media: { select: { id: true, url: true, espace: true } },
      ouvertures: { select: { userId: true, ouvertA: true, fermeA: true } },
      conv: { select: { participants: { select: { userId: true } } } },
    },
  });
  if (!message?.vueUnique || message.media.length === 0) return false;

  const destinataires = message.conv.participants
    .map((p) => p.userId)
    .filter((id) => id !== message.senderId);
  const closes = new Set(
    message.ouvertures.filter((o) => ouvertureClose(o, maintenant)).map((o) => o.userId),
  );
  const tousOntVu = destinataires.every((id) => closes.has(id));
  const abandonne = maintenant.getTime() - message.createdAt.getTime() > DELAI_ABANDON_MS;
  // Supprimé « pour tout le monde » : plus personne ne l'ouvrira, le fichier
  // n'a plus de raison d'exister.
  // Un message éphémère échu va être supprimé par la purge du serveur temps
  // réel, qui ne sait pas effacer le stockage : on passe avant elle.
  const supprime =
    message.deletedAt !== null ||
    (message.expiresAt !== null && message.expiresAt.getTime() <= maintenant.getTime());
  if (!tousOntVu && !abandonne && !supprime) return false;

  for (const f of message.media) {
    try {
      await effacerDefinitivement(f.url, f.espace);
    } catch (e) {
      console.error(`[vue-unique] effacement de ${f.id} reporté :`, e);
      return false;
    }
    await prisma.mediaFile.delete({ where: { id: f.id } }).catch(() => {});
  }
  await annoncer(message.convId, messageId, null, "vue_unique_effacee");
  return true;
}

/**
 * La purge de secours : les messages dont l'application n'a jamais dit
 * qu'elle refermait (tuée, réseau perdu), et ceux jamais ouverts depuis 14
 * jours. Lancée à intervalle régulier par `src/instrumentation.ts`.
 */
export async function purgerVuesUniques(): Promise<number> {
  const candidats = await prisma.message.findMany({
    where: { vueUnique: true, media: { some: {} } },
    select: { id: true },
    take: 500,
  });
  let effaces = 0;
  for (const c of candidats) {
    if (await tenterEffacement(c.id)) effaces++;
  }
  return effaces;
}

/**
 * Prévient les participants : l'expéditeur voit « Ouverte », les autres
 * appareils du destinataire aussi. Une sonnette — des identifiants, jamais
 * de contenu.
 */
async function annoncer(
  convId: string,
  messageId: string,
  userId: string | null,
  type: "vue_unique_ouverte" | "vue_unique_effacee",
) {
  const participants = await prisma.participant.findMany({
    where: { convId },
    select: { userId: true },
  });
  await previensDesPersonnes({
    personnes: participants.map((p) => p.userId),
    type,
    donnees: { convId, messageId, ...(userId ? { userId } : {}) },
  });
}

/**
 * L'état d'un message à vue unique, VU PAR `lecteur`, pour les sérialiseurs.
 *
 *   - destinataire : `ouverteParMoi` dit s'il a déjà ouvert ;
 *   - expéditeur : `ouverte` dit si au moins un destinataire a ouvert (en
 *     tête-à-tête : « l'autre a vu »).
 *
 * `effacee` : le fichier n'existe plus — plus rien à ouvrir pour personne.
 */
export function etatVueUnique(
  m: { vueUnique: boolean; senderId: string; media: unknown[]; ouvertures?: { userId: string }[] },
  lecteur: string,
) {
  if (!m.vueUnique) return {};
  const ouvertures = m.ouvertures ?? [];
  return {
    vueUnique: true,
    vueUniqueOuverte:
      m.senderId === lecteur
        ? ouvertures.length > 0
        : ouvertures.some((o) => o.userId === lecteur),
    vueUniqueEffacee: m.media.length === 0,
  };
}
