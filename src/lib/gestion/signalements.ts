import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { nomAffichage } from "@/lib/display-name.mjs";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";
import { ErreurAdmin } from "./reponses";
import { auteur, nomAuteur, type pagination } from "./outils";
import { type SessionAdmin } from "./session";

/**
 * LES SIGNALEMENTS (modération, 16/10/2026).
 *
 * Un utilisateur signale un message ou un compte (`POST /api/signalements`,
 * que l'application appellera à l'étape mobile) ; la console les trie.
 *
 * 🔴 L'EXTRAIT EST COPIÉ AU SIGNALEMENT. Le message peut être supprimé
 * ensuite ; le signalement doit rester lisible pour être jugé. Dans un fil
 * CHIFFRÉ, le serveur n'a pas le texte : c'est l'auteur du signalement qui le
 * fournit, en le déchiffrant chez lui — et c'est son choix de le révéler.
 */

export const MOTIFS = ["spam", "harcelement", "contenu_inapproprie", "fraude", "usurpation", "autre"] as const;
const TYPES_MESSAGE: Record<string, number> = { TEXT: 0, IMAGE: 1, FILE: 2, AUDIO: 3, VIDEO: 4, SYSTEM: 5, CONTACT: 6, LOCATION: 7 };

const signalementSchema = z.object({
  cible: z.enum(["message", "user"]),
  messageId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  motif: z.enum(MOTIFS),
  note: z.string().trim().max(1000).optional(),
  /// Pour un message chiffré seulement : le texte, déchiffré par l'auteur.
  extrait: z.string().max(4000).optional(),
});

/** Depuis l'application : un compte signale un message qu'il a reçu, ou un compte. */
export async function signaler(auteurId: string, brut: unknown) {
  const c = signalementSchema.parse(brut);
  if (c.cible === "message") {
    if (!c.messageId) throw new ErreurAdmin(400, "Message requis", "VALIDATION");
    const m = await prisma.message.findUnique({
      where: { id: c.messageId },
      select: { id: true, content: true, senderId: true, convId: true, conv: { select: { e2eeActif: true } } },
    });
    // On ne signale que ce qu'on a pu voir : un message d'un fil dont on est membre.
    const membre = m
      ? await prisma.participant.findFirst({ where: { convId: m.convId, userId: auteurId, ...MEMBRE_ACTIF }, select: { id: true } })
      : null;
    if (!m || !membre) throw new ErreurAdmin(404, "Message introuvable", "NOT_FOUND");
    if (m.senderId === auteurId) throw new ErreurAdmin(400, "On ne signale pas ses propres messages", "SELF");
    const extrait = m.content?.trim() ? m.content : m.conv.e2eeActif ? (c.extrait ?? null) : null;
    return creer({ cibleType: "message", messageId: m.id, userId: m.senderId, auteurId, motif: c.motif, note: c.note ?? null, extrait });
  }
  if (!c.userId) throw new ErreurAdmin(400, "Compte requis", "VALIDATION");
  if (c.userId === auteurId) throw new ErreurAdmin(400, "On ne se signale pas soi-même", "SELF");
  const u = await prisma.user.findUnique({ where: { id: c.userId }, select: { id: true } });
  if (!u) throw new ErreurAdmin(404, "Compte introuvable", "NOT_FOUND");
  return creer({ cibleType: "user", messageId: null, userId: u.id, auteurId, motif: c.motif, note: c.note ?? null, extrait: null });
}

async function creer(data: Prisma.GestionSignalementUncheckedCreateInput) {
  try {
    const s = await prisma.gestionSignalement.create({ data });
    return { id: Number(s.id), etat: s.etat };
  } catch (e) {
    // L'index unique partiel : déjà signalé par cet auteur, et pas encore traité.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ErreurAdmin(409, "Vous avez déjà signalé ceci", "ALREADY_REPORTED");
    }
    throw e;
  }
}

/* ══════════════ Console ══════════════ */

export async function listerSignalements(p: URLSearchParams, pg: ReturnType<typeof pagination>) {
  const etat = p.get("state");
  const q = p.get("search")?.trim();
  const recherche: Prisma.GestionSignalementWhereInput = q
    ? { OR: [{ note: { contains: q, mode: "insensitive" } }, { extrait: { contains: q, mode: "insensitive" } }, { motif: { contains: q } }] }
    : {};
  const where: Prisma.GestionSignalementWhereInput = { ...recherche, ...(etat ? { etat } : {}) };
  const [lignes, total, ouverts] = await Promise.all([
    prisma.gestionSignalement.findMany({
      where,
      orderBy: { creeLe: "desc" },
      skip: pg.skip,
      take: pg.limit,
      include: { _count: { select: { actions: true } } },
    }),
    prisma.gestionSignalement.count({ where }),
    prisma.gestionSignalement.count({ where: { ...recherche, etat: "open" } }),
  ]);
  const idsComptes = [...new Set(lignes.flatMap((l) => [l.auteurId, l.userId].filter(Boolean) as string[]))];
  const idsMessages = lignes.map((l) => l.messageId).filter(Boolean) as string[];
  const [comptes, messages] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: idsComptes } }, select: { id: true, nom: true, pseudo: true, publicNumber: true, exclus: true } }),
    prisma.message.findMany({ where: { id: { in: idsMessages } }, select: { id: true, type: true, content: true, deletedAt: true, createdAt: true, senderId: true } }),
  ]);
  const compte = (id: string | null) => (id ? comptes.find((c) => c.id === id) : undefined);
  return {
    items: lignes.map((l) => {
      const m = messages.find((x) => x.id === l.messageId);
      const vise = compte(l.userId);
      return {
        id: Number(l.id),
        targetType: l.cibleType,
        targetMsgId: l.messageId,
        targetUserId: l.userId,
        reason: l.motif,
        note: l.note,
        state: l.etat,
        createdAt: l.creeLe,
        reporterId: l.auteurId,
        reporterNom: compte(l.auteurId) ? nomAffichage(compte(l.auteurId)!) : null,
        targetNom: vise ? nomAffichage(vise) : null,
        targetExclus: vise?.exclus === 1,
        msgSenderId: l.cibleType === "message" ? l.userId : null,
        msgSenderNom: l.cibleType === "message" && vise ? nomAffichage(vise) : null,
        msgType: m ? (TYPES_MESSAGE[m.type] ?? null) : null,
        msgContent: l.extrait ?? m?.content ?? null,
        msgDeleted: l.cibleType === "message" && (!m || m.deletedAt !== null),
        msgSentAt: m?.createdAt ?? null,
        actions: l._count.actions,
      };
    }),
    total,
    open: ouverts,
    page: pg.page,
    limit: pg.limit,
  };
}

export async function actionsSignalement(id: bigint) {
  const lignes = await prisma.gestionSignalementAction.findMany({ where: { signalementId: id }, orderBy: { creeLe: "asc" } });
  return lignes.map((a) => ({ id: Number(a.id), action: a.action, note: a.note, createdAt: a.creeLe, adminId: null, adminNom: a.adminNom }));
}

const ETATS_CIBLES = ["reviewing", "actioned", "dismissed"];

/** Une décision : l'état change, et la décision reste au dossier avec sa note. */
export async function decider(id: bigint, brut: unknown, session: SessionAdmin) {
  const c = (brut ?? {}) as { action?: unknown; note?: unknown };
  const action = String(c.action ?? "");
  if (!ETATS_CIBLES.includes(action)) throw new ErreurAdmin(400, "Décision inconnue", "INVALID_ACTION");
  const note = typeof c.note === "string" && c.note.trim() ? c.note.trim().slice(0, 1000) : null;
  const s = await prisma.gestionSignalement.findUnique({ where: { id } });
  if (!s) throw new ErreurAdmin(404, "Signalement introuvable", "REPORT_NOT_FOUND");
  if (s.etat === "actioned" || s.etat === "dismissed") {
    throw new ErreurAdmin(409, "Ce signalement est déjà clos", "REPORT_CLOSED");
  }
  session.audit = { cibleType: "reports", cibleId: String(id), motif: note };
  await prisma.$transaction([
    prisma.gestionSignalement.update({ where: { id }, data: { etat: action } }),
    prisma.gestionSignalementAction.create({
      data: { signalementId: id, action, note, admin: auteur(session), adminNom: nomAuteur(session) },
    }),
  ]);
  return { ok: true, state: action };
}
