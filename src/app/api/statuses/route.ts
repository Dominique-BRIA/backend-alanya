import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createStatusSchema } from "@/lib/validation";

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
  user: { id: string; publicNumber: string; profile: { displayName: string; avatarUrl: string | null } | null };
  views: { id: string }[];
  _count: { views: number };
}

// GET /api/statuses — fil des statuts (les miens + ceux de mes contacts), non expirés,
// groupés par utilisateur.
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const myContacts = await prisma.contact.findMany({
    where: { userId, isBlocked: false },
    select: { contactId: true },
  });
  const contactIds = myContacts.map((c: { contactId: string }) => c.contactId);

  const now = new Date();
  const statuses = (await prisma.status.findMany({
    where: { userId: { in: [userId, ...contactIds] }, expiresAt: { gt: now } },
    orderBy: { createdAt: "asc" },
    include: {
      user: { include: { profile: true } },
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
      pseudo: u.profile?.displayName ?? null,
      avatarUrl: u.profile?.avatarUrl ?? null,
      publicNumber: u.publicNumber,
      hasUnviewed: list.some((s) => s.views.length === 0),
      statuses: list.map(mapStatus),
    };
  };

  const me = buildGroup(userId);
  const others = contactIds
    .map(buildGroup)
    .filter((g): g is NonNullable<typeof g> => g !== null)
    // Les contacts avec du non-vu en premier, puis par récence.
    .sort((a, b) => Number(b.hasUnviewed) - Number(a.hasUnviewed));

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
