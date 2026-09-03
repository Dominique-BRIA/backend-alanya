import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createStatusSchema } from "@/lib/validation";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";
import {
  auteursCandidatsPour,
  auteursVisiblesPour,
} from "@/lib/statut-visibilite";

const DAY_MS = 24 * 60 * 60 * 1000;

// Forme locale (compatible avec le type Prisma une fois le client généré).
interface StatusWithMeta {
  id: string;
  userId: string;
  type: string;
  text: string | null;
  mediaUrl: string | null;
  bgColor: string | null;
  createdAt: Date;
  expiresAt: Date;
  user: { id: string; publicNumber: string; pseudo: string | null; avatarUrl: string | null };
  views: { id: string }[];
  _count: { views: number };
}

// GET /api/statuses — fil des statuts (les miens + ceux de mes contacts), non expirés,
// groupés par utilisateur.
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  /*
   * 🔴 L'AUDIENCE DÉCIDE, PLUS LE SEUL RÉPERTOIRE.
   *
   * Avant : « les statuts de mes contacts non bloqués », point. Deux trous —
   * l'auteur n'avait aucun moyen de restreindre son audience, et le blocage
   * n'était vu que dans un sens (`Contact.isBlocked` n'est mis à jour que
   * quand MOI je bloque ; qui me bloquait continuait d'être vu).
   *
   * La règle est maintenant tenue en un seul endroit, partagé avec le média et
   * l'enregistrement d'une vue.
   */
  const candidats = await auteursCandidatsPour(userId);
  const visibles = await auteursVisiblesPour(userId, candidats);
  const contactIds = [...visibles].filter((id) => id !== userId);

  const now = new Date();
  const statuses = (await prisma.status.findMany({
    where: { userId: { in: [...visibles] }, expiresAt: { gt: now } },
    orderBy: { createdAt: "asc" },
    include: {
      user: true,
      views: { where: { viewerId: userId }, select: { id: true } },
      _count: { select: { views: true } },
    },
  })) as unknown as StatusWithMeta[];

  // Regroupe par auteur.
  const byUser = new Map<string, StatusWithMeta[]>();
  for (const s of statuses) {
    (byUser.get(s.userId) ?? byUser.set(s.userId, []).get(s.userId)!).push(s);
  }

  const mapStatus = (s: StatusWithMeta) => ({
    id: s.id,
    type: s.type,
    text: s.text,
    mediaUrl: s.mediaUrl,
    bgColor: s.bgColor,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    viewed: s.views.length > 0,
    viewsCount: s._count.views,
  });

  const buildGroup = (uid: string) => {
    const list = byUser.get(uid) ?? [];
    if (list.length === 0) return null;
    const u = list[0]!.user;
    return {
      userId: uid,
      pseudo: nomAffichage(u),
      avatarUrl: avatarPublicUrl(u.avatarUrl ?? null),
      publicNumber: u.publicNumber,
      hasUnviewed: list.some((s) => s.views.length === 0),
      statuses: list.map(mapStatus),
    };
  };

  const me = buildGroup(userId);
  // Le plus récent des statuts d'une personne : c'est lui qui la classe.
  const dernier = (uid: string) =>
    (byUser.get(uid) ?? []).reduce(
      (max, s) => (s.createdAt > max ? s.createdAt : max),
      new Date(0),
    );

  const others = contactIds
    .map(buildGroup)
    .filter((g): g is NonNullable<typeof g> => g !== null)
    // Non-vus en tête, PUIS par récence. Le tri par récence manquait, alors
    // que le commentaire l'annonçait : l'ordre retombait sur celui d'ajout des
    // contacts, qui ne veut rien dire pour qui regarde.
    .sort(
      (a, b) =>
        Number(b.hasUnviewed) - Number(a.hasUnviewed) ||
        dernier(b.userId).getTime() - dernier(a.userId).getTime(),
    );

  return ok({ me, others });
});

// POST /api/statuses — publie un statut (texte avec fond coloré, ou média).
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const data = createStatusSchema.parse(await req.json());

  let mediaUrl: string | null = null;
  if (data.mediaId) {
    const media = await prisma.mediaFile.findUnique({ where: { id: data.mediaId } });
    if (!media || media.ownerId !== userId) return fail("Média introuvable", 404, "NOT_FOUND");
    mediaUrl = `/api/media/${media.id}`;
  }

  const bg = data.bgColor ? (data.bgColor.startsWith("#") ? data.bgColor : `#${data.bgColor}`) : null;

  const status = await prisma.status.create({
    data: {
      userId,
      type: data.type,
      text: data.text ?? null,
      bgColor: bg,
      mediaUrl,
      expiresAt: new Date(Date.now() + DAY_MS),
    },
  });

  return ok({ id: status.id, expiresAt: status.expiresAt }, 201);
});
