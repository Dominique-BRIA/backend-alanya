import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { isGroupAdmin } from "@/lib/groups";

// GET /api/conversations/:id/members — liste les membres du groupe.
export const GET = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: {
      participants: {
        include: { user: true },
      },
    },
  });
  if (!conv) return fail("Conversation introuvable", 404, "NOT_FOUND");

  const isMember = conv.participants.some((p) => p.userId === userId);
  if (!isMember) return fail("Accès refusé", 403, "FORBIDDEN");

  return ok({
    members: conv.participants.map((p) => ({
      id: p.userId,
      pseudo: p.user.pseudo ?? null,
      publicNumber: p.user.publicNumber,
      avatarUrl: p.user.avatarUrl ?? null,
      // Confidentialité : masque la présence d'un membre qui a choisi « personne ».
      isOnline:
        p.userId !== userId && p.user.lastSeenVisibility === 0
          ? 0
          : p.user.isOnline,
      role: p.role,
      joinedAt: p.joinedAt,
    })),
  });
});

// POST /api/conversations/:id/members — ajouter des membres au groupe.
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  const { publicNumbers } = await req.json(); // string[]

  if (!Array.isArray(publicNumbers) || publicNumbers.length === 0) {
    return fail("Aucun numéro fourni", 400, "NO_NUMBERS");
  }

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: { participants: true },
  });
  if (!conv) return fail("Conversation introuvable", 404, "NOT_FOUND");
  if (!conv.isGroup) return fail("Ce n'est pas un groupe", 400, "NOT_GROUP");

  // Seul un admin peut ajouter des membres (symétrique du retrait).
  const me = conv.participants.find((p) => p.userId === userId);
  if (!me) return fail("Accès refusé", 403, "FORBIDDEN");
  if (!isGroupAdmin(conv.participants, userId)) {
    return fail("Seul un admin peut ajouter des membres", 403, "NOT_ADMIN");
  }

  // Trouve les utilisateurs par numéro public
  const users = await prisma.user.findMany({
    where: { publicNumber: { in: publicNumbers } },
    select: { id: true, publicNumber: true },
  });

  const existingMemberIds = new Set(conv.participants.map((p) => p.userId));
  const toAdd = users.filter((u) => !existingMemberIds.has(u.id));

  if (toAdd.length === 0) {
    return fail("Tous les utilisateurs sont déjà membres", 400, "ALREADY_MEMBERS");
  }

  await prisma.participant.createMany({
    data: toAdd.map((u) => ({
      convId,
      userId: u.id,
      role: "MEMBER" as const,
    })),
  });

  return ok({
    message: `${toAdd.length} membre(s) ajouté(s)`,
    added: toAdd.map((u) => u.publicNumber),
  });
});

// DELETE /api/conversations/:id/members?userId=xxx — retirer un membre du groupe.
// Le userId à retirer est passé en query param (pas en body JSON).
export const DELETE = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;

  // Lit le userId cible depuis l'URL query param
  const url = new URL(req.url);
  const targetId = url.searchParams.get("userId");

  if (!targetId) {
    return fail("userId manquant dans l'URL", 400, "MISSING_USER_ID");
  }

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: { participants: true },
  });
  if (!conv) return fail("Conversation introuvable", 404, "NOT_FOUND");
  if (!conv.isGroup) return fail("Ce n'est pas un groupe", 400, "NOT_GROUP");

  // Seul un admin peut retirer des membres (ou soi-même qui quitte)
  const me = conv.participants.find((p) => p.userId === userId);
  if (!me) return fail("Accès refusé", 403, "FORBIDDEN");

  if (targetId !== userId && !isGroupAdmin(conv.participants, userId)) {
    return fail("Seul un admin peut retirer des membres", 403, "NOT_ADMIN");
  }

  const target = conv.participants.find((p) => p.userId === targetId);
  if (!target) return fail("Membre introuvable dans ce groupe", 404, "NOT_MEMBER");

  await prisma.participant.delete({
    where: { convId_userId: { convId, userId: targetId } },
  });

  // Si c'est soi-même qui quitte, on peut aussi supprimer la conv si vide
  if (targetId === userId) {
    const remaining = await prisma.participant.count({ where: { convId } });
    if (remaining === 0) {
      await prisma.conversation.delete({ where: { id: convId } });
    }
  }

  return ok({ message: "Membre retiré", userId: targetId });
});

// PATCH /api/conversations/:id/members — change le rôle d'un membre.
// Body : { userId: string, role: "ADMIN" | "MEMBER" }. Réservé aux admins.
export const PATCH = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  const { userId: targetId, role } = await req.json();

  if (typeof targetId !== "string" || (role !== "ADMIN" && role !== "MEMBER")) {
    return fail("Paramètres invalides", 400, "BAD_PARAMS");
  }

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: { participants: true },
  });
  if (!conv) return fail("Conversation introuvable", 404, "NOT_FOUND");
  if (!conv.isGroup) return fail("Ce n'est pas un groupe", 400, "NOT_GROUP");

  if (!isGroupAdmin(conv.participants, userId)) {
    return fail("Seul un admin peut changer les rôles", 403, "NOT_ADMIN");
  }

  const target = conv.participants.find((p) => p.userId === targetId);
  if (!target) return fail("Membre introuvable dans ce groupe", 404, "NOT_MEMBER");

  await prisma.participant.update({
    where: { convId_userId: { convId, userId: targetId } },
    data: { role },
  });

  return ok({
    message: role === "ADMIN" ? "Promu administrateur" : "Rétrogradé membre",
    userId: targetId,
    role,
  });
});
