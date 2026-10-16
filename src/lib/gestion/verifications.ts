import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { nomAffichage } from "@/lib/display-name.mjs";
import { invaliderProfil } from "@/lib/cache-redis.mjs";
import { TYPE_COMPTE_OFFICIEL } from "@/lib/compte-officiel.mjs";
import { ErreurAdmin } from "./reponses";
import { nomAuteur } from "./outils";
import { type SessionAdmin } from "./session";

/**
 * LA VÉRIFICATION DES COMPTES — le badge « vérifié » (16/10/2026).
 *
 * Un compte demande le badge depuis l'application (`POST /api/verification`,
 * pour l'étape mobile) avec le nom qu'il revendique et ses pièces ; la
 * console approuve, refuse, demande une pièce, ou révoque.
 *
 * L'état du badge vit sur le compte (`users.verification_statut`,
 * `verifie_jusqua`) : c'est ce que l'application lira pour l'afficher. Les
 * demandes et leurs pièces vivent dans `gestion_verification*`.
 *
 * 🔴 LE BADGE EST ATTACHÉ AU NOM APPROUVÉ. Un compte qui change de nom après
 * l'approbation remonte dans la file « renommés » : sinon, on ferait certifier
 * « Banque X » à quelqu'un qui s'appelait autrement au moment de l'examen.
 *
 * ⚠️ LES PIÈCES SONT DES DONNÉES SENSIBLES : chaque ouverture est comptée et
 * journalisée, et elles ne quittent jamais le stockage privé.
 */

export const STATUT = { NON_DEMANDE: 0, EN_COURS: 1, VERIFIE: 2, REFUSE: 3, REVOQUE: 4, EXPIRE: 5 } as const;
const DUREE_BADGE_MS = 365 * 86_400_000;

type Demande = Prisma.GestionVerificationGetPayload<{ include: { _count: { select: { documents: true } } } }>;
type Compte = { id: string; nom: string | null; pseudo: string | null; publicNumber: string; avatarUrl: string | null; typeCompte: number };

function presenterDemande(d: Demande, u: Compte | undefined) {
  const nomActuel = u ? (nomAffichage(u) ?? "") : "";
  return {
    id: Number(d.id),
    alanyaId: d.userId,
    userName: u ? nomActuel : null,
    pseudo: u?.pseudo ?? null,
    avatarUrl: u?.avatarUrl ?? null,
    accountType: u?.typeCompte === TYPE_COMPTE_OFFICIEL ? 2 : 0,
    targetType: 0,
    claimedName: d.nomRevendique,
    nameAtApproval: d.nomApprouve,
    nameChanged: d.statut === "approved" && !!d.nomApprouve && !!u && d.nomApprouve !== nomActuel,
    status: d.statut,
    reason: d.motif,
    revokeReason: d.motifRevocation,
    reviewerName: d.decidePar,
    documents: d._count.documents,
    createdAt: d.creeLe,
    decidedAt: d.decideLe,
    revokedAt: d.revoqueLe,
  };
}

const CHAMPS_COMPTE = { id: true, nom: true, pseudo: true, publicNumber: true, avatarUrl: true, typeCompte: true } as const;

async function presenterListe(demandes: Demande[]) {
  const comptes = await prisma.user.findMany({ where: { id: { in: demandes.map((d) => d.userId) } }, select: CHAMPS_COMPTE });
  return demandes.map((d) => presenterDemande(d, comptes.find((c) => c.id === d.userId)));
}

export async function listerDemandes(file: string, limite: number) {
  const where: Prisma.GestionVerificationWhereInput =
    file === "pending"
      ? { statut: "pending" }
      : file === "documents"
        ? { statut: "document_requested" }
        : file === "renamed" || file === "decided"
          ? { statut: file === "renamed" ? "approved" : { in: ["approved", "refused", "revoked", "cancelled"] } }
          : {};
  const demandes = await prisma.gestionVerification.findMany({
    where,
    orderBy: { creeLe: file === "pending" ? "asc" : "desc" },
    take: file === "renamed" ? 1000 : Math.min(500, limite),
    include: { _count: { select: { documents: true } } },
  });
  const lignes = await presenterListe(demandes);
  return file === "renamed" ? lignes.filter((l) => l.nameChanged).slice(0, limite) : lignes;
}

export async function compterFiles() {
  const [pending, documents, approuvees] = await Promise.all([
    prisma.gestionVerification.count({ where: { statut: "pending" } }),
    prisma.gestionVerification.count({ where: { statut: "document_requested" } }),
    prisma.gestionVerification.findMany({ where: { statut: "approved" }, include: { _count: { select: { documents: true } } } }),
  ]);
  const renamed = (await presenterListe(approuvees)).filter((l) => l.nameChanged).length;
  return { pending, documents, renamed };
}

export async function detailDemande(id: bigint) {
  const d = await prisma.gestionVerification.findUnique({
    where: { id },
    include: { _count: { select: { documents: true } }, documents: { orderBy: { deposeLe: "asc" } } },
  });
  if (!d) throw new ErreurAdmin(404, "Demande introuvable", "VERIFICATION_NOT_FOUND");
  const [u, historique, medias] = await Promise.all([
    prisma.user.findUnique({ where: { id: d.userId }, select: { ...CHAMPS_COMPTE, verificationStatut: true, verifieJusqua: true, createdAt: true } }),
    prisma.gestionVerification.findMany({
      where: { userId: d.userId, id: { not: id } },
      orderBy: { creeLe: "desc" },
      include: { _count: { select: { documents: true } } },
    }),
    prisma.mediaFile.findMany({ where: { id: { in: d.documents.map((x) => x.mediaId) } }, select: { id: true, mimeType: true, sizeBytes: true } }),
  ]);
  return {
    request: presenterDemande(d, u ?? undefined),
    user: u
      ? {
          alanyaId: u.id,
          nom: u.nom ?? "",
          pseudo: u.pseudo ?? "",
          avatarUrl: u.avatarUrl,
          alanyaPhone: u.publicNumber,
          accountType: u.typeCompte === TYPE_COMPTE_OFFICIEL ? 2 : 0,
          verificationStatus: u.verificationStatut,
          verifiedUntil: u.verifieJusqua,
          createdAt: u.createdAt,
        }
      : null,
    documents: d.documents.map((x) => {
      const m = medias.find((y) => y.id === x.mediaId);
      return {
        id: Number(x.id),
        docType: x.typeDoc,
        mime: m?.mimeType ?? "application/octet-stream",
        size: m?.sizeBytes ?? 0,
        uploadedAt: x.deposeLe,
        purgeAfter: null,
        purged: !m,
        views: x.vues,
      };
    }),
    history: historique.map((h) => presenterDemande(h, u ?? undefined)),
  };
}

/** Une décision de la console sur une demande. */
export async function decider(id: bigint, decision: string, motifBrut: unknown, session: SessionAdmin) {
  const motif = typeof motifBrut === "string" && motifBrut.trim() ? motifBrut.trim().slice(0, 500) : null;
  const d = await prisma.gestionVerification.findUnique({ where: { id } });
  if (!d) throw new ErreurAdmin(404, "Demande introuvable", "VERIFICATION_NOT_FOUND");
  const u = await prisma.user.findUnique({ where: { id: d.userId }, select: CHAMPS_COMPTE });
  const nomActuel = u ? (nomAffichage(u) ?? d.nomRevendique) : d.nomRevendique;
  const ouverte = d.statut === "pending" || d.statut === "document_requested";
  const maintenant = new Date();
  const par = nomAuteur(session);
  session.audit = { cibleType: "verifications", cibleId: String(id), motif };

  let demande: Prisma.GestionVerificationUpdateInput;
  let compte: Prisma.UserUpdateInput;
  switch (decision) {
    case "approve":
      if (!ouverte) throw new ErreurAdmin(409, "Cette demande n'est plus ouverte", "NOT_OPEN");
      demande = { statut: "approved", nomApprouve: nomActuel, motif, decidePar: par, decideLe: maintenant };
      compte = { verificationStatut: STATUT.VERIFIE, verifieJusqua: new Date(maintenant.getTime() + DUREE_BADGE_MS) };
      break;
    case "refuse":
      if (!ouverte) throw new ErreurAdmin(409, "Cette demande n'est plus ouverte", "NOT_OPEN");
      if (!motif) throw new ErreurAdmin(400, "Le motif du refus est requis", "REASON_REQUIRED");
      demande = { statut: "refused", motif, decidePar: par, decideLe: maintenant };
      compte = { verificationStatut: STATUT.REFUSE, verifieJusqua: null };
      break;
    case "request-document":
      if (!ouverte) throw new ErreurAdmin(409, "Cette demande n'est plus ouverte", "NOT_OPEN");
      if (!motif) throw new ErreurAdmin(400, "Dites quelle pièce manque", "REASON_REQUIRED");
      demande = { statut: "document_requested", motif, decidePar: par };
      compte = { verificationStatut: STATUT.EN_COURS };
      break;
    case "revoke":
      if (d.statut !== "approved") throw new ErreurAdmin(409, "Seule une demande approuvée se révoque", "NOT_APPROVED");
      if (!motif) throw new ErreurAdmin(400, "Le motif de la révocation est requis", "REASON_REQUIRED");
      demande = { statut: "revoked", motifRevocation: motif, revoqueLe: maintenant };
      compte = { verificationStatut: STATUT.REVOQUE, verifieJusqua: null };
      break;
    case "reconfirm":
      // Le compte a changé de nom : on certifie le nouveau, sans nouvelle demande.
      if (d.statut !== "approved") throw new ErreurAdmin(409, "Seule une demande approuvée se reconfirme", "NOT_APPROVED");
      demande = { nomApprouve: nomActuel, decidePar: par, decideLe: maintenant };
      compte = { verificationStatut: STATUT.VERIFIE };
      break;
    default:
      throw new ErreurAdmin(404, "Décision inconnue", "INVALID_DECISION");
  }
  await prisma.$transaction([
    prisma.gestionVerification.update({ where: { id }, data: demande }),
    prisma.user.update({ where: { id: d.userId }, data: compte }),
  ]);
  await invaliderProfil(d.userId);
  return detailDemande(id);
}

/** Retire ou rend le badge depuis la fiche du compte (`/users/:id/badge/*`). */
export async function changerBadge(userId: string, rendre: boolean, motif: string, session: SessionAdmin) {
  const approuvee = await prisma.gestionVerification.findFirst({
    where: { userId, statut: rendre ? "revoked" : "approved" },
    orderBy: { creeLe: "desc" },
  });
  if (!approuvee) {
    throw new ErreurAdmin(409, rendre ? "Aucun badge révoqué à rendre" : "Ce compte n'a pas de badge", "NO_BADGE");
  }
  if (rendre) {
    await prisma.$transaction([
      prisma.gestionVerification.update({
        where: { id: approuvee.id },
        data: { statut: "approved", revoqueLe: null, motifRevocation: null, decidePar: nomAuteur(session), decideLe: new Date() },
      }),
      prisma.user.update({
        where: { id: userId },
        data: { verificationStatut: STATUT.VERIFIE, verifieJusqua: new Date(Date.now() + DUREE_BADGE_MS) },
      }),
    ]);
  } else {
    await decider(approuvee.id, "revoke", motif || "Badge retiré par l'administration", session);
  }
  await invaliderProfil(userId);
}

/* ══════════════ Côté application ══════════════ */

const demandeSchema = z.object({
  nom: z.string().trim().min(2).max(150),
  /// 1 pièce d'identité, 4 selfie avec la pièce — des médias déjà téléversés par le compte.
  documents: z.array(z.object({ type: z.union([z.literal(1), z.literal(4)]), mediaId: z.string().uuid() })).min(1).max(4),
});

export async function demanderVerification(userId: string, brut: unknown) {
  const c = demandeSchema.parse(brut);
  const medias = await prisma.mediaFile.findMany({ where: { id: { in: c.documents.map((d) => d.mediaId) } }, select: { id: true, ownerId: true, chiffre: true } });
  if (medias.length !== c.documents.length || medias.some((m) => m.ownerId !== userId || m.chiffre)) {
    throw new ErreurAdmin(403, "Pièce inconnue ou qui ne vous appartient pas", "MEDIA_FORBIDDEN");
  }
  const ouverte = await prisma.gestionVerification.findFirst({ where: { userId, statut: { in: ["pending", "document_requested"] } } });
  if (ouverte?.statut === "pending") throw new ErreurAdmin(409, "Une demande est déjà en cours d'examen", "ALREADY_PENDING");
  const demande = ouverte
    ? await prisma.gestionVerification.update({ where: { id: ouverte.id }, data: { statut: "pending", nomRevendique: c.nom } })
    : await prisma.gestionVerification.create({ data: { userId, nomRevendique: c.nom } });
  await prisma.gestionVerificationDocument.createMany({
    data: c.documents.map((d) => ({ verificationId: demande.id, typeDoc: d.type, mediaId: d.mediaId })),
  });
  await prisma.user.update({ where: { id: userId }, data: { verificationStatut: STATUT.EN_COURS } });
  return etatVerification(userId);
}

export async function etatVerification(userId: string) {
  const [u, d] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { verificationStatut: true, verifieJusqua: true } }),
    prisma.gestionVerification.findFirst({ where: { userId }, orderBy: { creeLe: "desc" } }),
  ]);
  return {
    statut: u?.verificationStatut ?? 0,
    verifieJusqua: u?.verifieJusqua ?? null,
    demande: d ? { id: Number(d.id), statut: d.statut, nom: d.nomRevendique, motif: d.motif, creeLe: d.creeLe } : null,
  };
}
