import { prisma } from "@/lib/prisma";
import { nomAffichage } from "@/lib/display-name.mjs";
import { previensLaSalle } from "@/lib/salle-temps-reel";
import { adressePublique, effacerDefinitivement, getSignedDownloadUrl } from "@/modules/media/storage";
import { ErreurAdmin } from "./reponses";

/**
 * GROUPES, MÉDIAS ET RÉUNIONS vus de la console de gestion (16/10/2026).
 *
 * 🔴 LA CONSOLE NE LIT RIEN DE CHIFFRÉ, et ne le pourrait pas : le texte d'un
 * fil chiffré n'est pas sur le serveur, et un média chiffré n'y est qu'un
 * bloc opaque. Elle les signale comme tels au lieu de faire semblant.
 */

const LIBELLE_CHIFFRE = "🔒 Message chiffré";
const TYPES_MEDIA: Record<string, number> = { TEXT: 0, IMAGE: 1, FILE: 2, AUDIO: 3, VIDEO: 4 };

/** Une adresse où l'administrateur peut VOIR le fichier : publique, sinon signée (10 min). */
async function adresseConsultable(m: { url: string; espace: string | null; chiffre: boolean }) {
  if (m.chiffre) return "";
  const pub = adressePublique(m.url, m.espace);
  if (pub) return pub;
  return (await getSignedDownloadUrl(m.url, { expiresInSec: 600 }).catch(() => null)) ?? "";
}

/* ══════════════ Groupes ══════════════ */

export async function listerGroupes(q?: string | null) {
  const groupes = await prisma.conversation.findMany({
    where: { isGroup: true, ...(q ? { name: { contains: q, mode: "insensitive" } } : {}) },
    orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: 500,
    include: { _count: { select: { participants: { where: { estMembre: true } } } } },
  });
  return groupes.map((g) => ({
    conversID: g.id,
    GroupName: g.name ?? "Groupe",
    groupPhoto: g.avatarUrl ?? "",
    lastMessage: g.e2eeActif && g.lastMessage === null && g.lastMessageAt ? LIBELLE_CHIFFRE : (g.lastMessage ?? ""),
    lastMessageAt: g.lastMessageAt,
    members: g._count.participants,
    createdAt: g.createdAt,
    e2eeActif: g.e2eeActif,
  }));
}

export async function detailGroupe(id: string) {
  const g = await prisma.conversation.findUnique({
    where: { id },
    include: {
      participants: {
        where: { estMembre: true },
        include: { user: { select: { id: true, nom: true, pseudo: true, avatarUrl: true, publicNumber: true, isOnline: true, lastSeen: true, typeCompte: true } } },
      },
      _count: { select: { messages: true } },
    },
  });
  if (!g || !g.isGroup) throw new ErreurAdmin(404, "Groupe introuvable", "GROUP_NOT_FOUND");
  return {
    conversID: g.id,
    GroupName: g.name ?? "Groupe",
    groupPhoto: g.avatarUrl,
    lastMessage: g.e2eeActif && g.lastMessage === null && g.lastMessageAt ? LIBELLE_CHIFFRE : g.lastMessage,
    lastMessageAt: g.lastMessageAt,
    memberCount: g.participants.length,
    messageCount: g._count.messages,
    createdAt: g.createdAt,
    e2eeActif: g.e2eeActif,
    members: g.participants.map((p) => ({
      alanyaID: p.user.id,
      nom: p.user.nom ?? "",
      pseudo: p.user.pseudo ?? "",
      avatarUrl: p.user.avatarUrl,
      alanyaPhone: p.user.publicNumber,
      isOnline: p.user.isOnline === 1,
      lastSeen: p.user.lastSeen,
      typeCompte: p.user.typeCompte,
      joinedAt: p.joinedAt,
      role: p.role,
    })),
  };
}

/**
 * Supprime un groupe et tout ce qu'il contient. Les fichiers de ses messages
 * sont effacés du stockage AVANT les lignes : après, plus rien ne les
 * désignerait, et ils resteraient payés et lisibles pour toujours.
 */
export async function supprimerGroupe(id: string) {
  const g = await prisma.conversation.findUnique({ where: { id }, select: { isGroup: true } });
  if (!g || !g.isGroup) throw new ErreurAdmin(404, "Groupe introuvable", "GROUP_NOT_FOUND");
  const fichiers = await prisma.mediaFile.findMany({
    where: { message: { convId: id } },
    select: { url: true, espace: true },
  });
  for (const f of fichiers) await effacerDefinitivement(f.url, f.espace).catch(() => {});
  await prisma.conversation.delete({ where: { id } });
  return { fichiers: fichiers.length };
}

/* ══════════════ Médias ══════════════ */

export async function listerMedias(p: URLSearchParams) {
  const type = p.get("type");
  const limit = Math.min(200, Math.max(1, Number(p.get("limit")) || 100));
  const medias = await prisma.mediaFile.findMany({
    where: {
      messageId: { not: null },
      chiffre: false,
      message: { deletedAt: null, ...(type && TYPES_MEDIA[type] !== undefined ? { type: type as never } : {}) },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      message: {
        select: {
          type: true,
          createdAt: true,
          sender: { select: { id: true, nom: true, pseudo: true, avatarUrl: true } },
          conv: { select: { id: true, isGroup: true, name: true } },
        },
      },
    },
  });
  return Promise.all(
    medias.map(async (m) => ({
      id: m.id,
      senderID: m.message!.sender.id,
      senderNom: m.message!.sender.nom ?? "",
      senderPseudo: m.message!.sender.pseudo ?? "",
      senderAvatar: m.message!.sender.avatarUrl ?? "",
      conversationID: m.message!.conv.id,
      conversationName: m.message!.conv.isGroup ? (m.message!.conv.name ?? "Groupe") : "Conversation privée",
      type: TYPES_MEDIA[m.message!.type] ?? 2,
      mediaUrl: await adresseConsultable(m),
      mediaName: m.filename,
      mimeType: m.mimeType,
      size: m.sizeBytes,
      sendAt: m.message!.createdAt,
    })),
  );
}

/**
 * Retire un média : le fichier est effacé du stockage, la ligne supprimée,
 * et un message qui n'avait que lui pour contenu devient « supprimé ».
 */
export async function supprimerMedia(id: string) {
  const m = await prisma.mediaFile.findUnique({
    where: { id },
    include: { message: { select: { id: true, content: true, _count: { select: { media: true } } } } },
  });
  if (!m) throw new ErreurAdmin(404, "Média introuvable", "MEDIA_NOT_FOUND");
  await effacerDefinitivement(m.url, m.espace).catch(() => {});
  await prisma.mediaFile.delete({ where: { id } });
  if (m.message && m.message._count.media <= 1 && !m.message.content?.trim()) {
    await prisma.message.update({ where: { id: m.message.id }, data: { deletedAt: new Date() } });
  }
}

/* ══════════════ Réunions ══════════════ */

export async function listerReunions() {
  const reunions = await prisma.meeting.findMany({
    orderBy: { start_time: "desc" },
    take: 500,
    include: {
      organiser: { select: { nom: true, pseudo: true, avatarUrl: true, publicNumber: true } },
      _count: { select: { participants: true } },
    },
  });
  return reunions.map((r) => ({
    idMeeting: r.idMeeting,
    idOrganiser: r.idOrganiser,
    organiserNom: r.organiser ? (nomAffichage(r.organiser) ?? "") : "",
    organiserPseudo: r.organiser?.pseudo ?? "",
    organiserAvatar: r.organiser?.avatarUrl ?? "",
    objet: r.objet,
    room: r.room,
    startTime: r.start_time,
    duree: r.duree,
    isEnd: r.isEnd,
    typeMedia: r.type_media,
    participants: r._count.participants,
    createdAt: r.start_time,
  }));
}

/** Termine une réunion comme le ferait son organisateur : durées closes, salle prévenue. */
export async function terminerReunion(id: number) {
  const r = await prisma.meeting.findUnique({ where: { idMeeting: id }, include: { participants: true } });
  if (!r) throw new ErreurAdmin(404, "Réunion introuvable", "MEETING_NOT_FOUND");
  if (r.isEnd === 1) throw new ErreurAdmin(409, "Cette réunion est déjà terminée", "ALREADY_ENDED");
  await prisma.meeting.update({ where: { idMeeting: id }, data: { isEnd: 1 } });
  const maintenant = new Date();
  for (const p of r.participants) {
    if (p.connecte === 1) {
      const duree = p.start_time ? Math.round((maintenant.getTime() - p.start_time.getTime()) / 1000) : p.duree;
      await prisma.meetingParticipant.update({ where: { ID: p.ID }, data: { connecte: 0, duree } });
    }
  }
  await previensLaSalle({ meetingId: id, type: "meeting_ended" });
}

export async function supprimerReunion(id: number) {
  const r = await prisma.meeting.findUnique({ where: { idMeeting: id }, select: { isEnd: true } });
  if (!r) throw new ErreurAdmin(404, "Réunion introuvable", "MEETING_NOT_FOUND");
  if (r.isEnd !== 1) await terminerReunion(id);
  await prisma.meeting.delete({ where: { idMeeting: id } });
}
