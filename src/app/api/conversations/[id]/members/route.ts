import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

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

  // Répare les anciens groupes créés avant les rôles explicites : le premier
  // participant chronologique devient admin, une seule fois.
  if (!conv.participants.some((p) => p.role === "ADMIN")) {
    const first = [...conv.participants].sort((a,b) => a.joinedAt.getTime()-b.joinedAt.getTime())[0];
    if (first) { await prisma.participant.update({ where: { convId_userId: { convId, userId: first.userId } }, data: { role: "ADMIN" } }); first.role = "ADMIN"; }
  }
  const isMember = conv.participants.some((p) => p.userId === userId);
  if (!isMember) return fail("Accès refusé", 403, "FORBIDDEN");

  return ok({
    members: conv.participants.map((p) => ({
      id: p.userId,
      pseudo: p.user.pseudo ?? null,
      publicNumber: p.user.publicNumber,
      avatarUrl: p.user.avatarUrl ?? null,
      isOnline: p.user.isOnline,
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

  const me = conv.participants.find((p) => p.userId === userId);
  if (!me) return fail("Accès refusé", 403, "FORBIDDEN");
  if (me.role !== "ADMIN") return fail("Seul un admin peut ajouter des membres", 403, "NOT_ADMIN");

  // Trouve les utilisateurs par numéro public
  const users = await prisma.user.findMany({
    where: { publicNumber: { in: publicNumbers } },
    select: { id: true, publicNumber: true, pseudo: true },
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

  const actor = await prisma.user.findUnique({ where: { id: userId }, select: { pseudo: true, publicNumber: true } });
  await prisma.message.create({ data: { convId, senderId: userId, type: "SYSTEM", content: `${toAdd.map((u) => u.pseudo ?? u.publicNumber).join(", ")} a été ajouté au groupe par ${actor?.pseudo ?? actor?.publicNumber ?? "un administrateur"}` } });
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

  const hasAdmin = conv.participants.some((p) => p.role === "ADMIN");
  const isFirst = conv.participants[0]?.userId === userId;
  const isAdmin = me.role === "ADMIN" || (!hasAdmin && isFirst);

  if (targetId !== userId && !isAdmin) {
    return fail("Seul un admin peut retirer des membres", 403, "NOT_ADMIN");
  }

  const target = conv.participants.find((p) => p.userId === targetId);
  if (!target) return fail("Membre introuvable dans ce groupe", 404, "NOT_MEMBER");

  const targetUser = await prisma.user.findUnique({ where: { id: targetId }, select: { pseudo: true, publicNumber: true } });
  const actor = await prisma.user.findUnique({ where: { id: userId }, select: { pseudo: true, publicNumber: true } });
  await prisma.participant.delete({ where: { convId_userId: { convId, userId: targetId } } });
  if (targetId !== userId) await prisma.message.create({ data: { convId, senderId: userId, type: "SYSTEM", content: `${targetUser?.pseudo ?? targetUser?.publicNumber ?? "Un membre"} a été retiré du groupe par ${actor?.pseudo ?? actor?.publicNumber ?? "un administrateur"}` } });

  // Si c'est soi-même qui quitte, on peut aussi supprimer la conv si vide
  if (targetId === userId) {
    const remaining = await prisma.participant.count({ where: { convId } });
    if (remaining === 0) {
      await prisma.conversation.delete({ where: { id: convId } });
    }
  }

  return ok({ message: "Membre retiré", userId: targetId });
});

// PATCH /members — promotion ou retrait du droit admin.
export const PATCH = withAuth(async (req: NextRequest, userId: string, ctx) => { const { id: convId } = await ctx.params; const { userId: targetId, role } = await req.json(); if (!targetId || !["ADMIN","MEMBER"].includes(role)) return fail("Données invalides",400,"BAD_REQUEST"); const me=await prisma.participant.findUnique({where:{convId_userId:{convId,userId}}}); if(!me || me.role!=="ADMIN") return fail("Seul un admin peut gérer les rôles",403,"NOT_ADMIN"); const target=await prisma.participant.findUnique({where:{convId_userId:{convId,userId:targetId}}}); if(!target) return fail("Membre introuvable",404,"NOT_MEMBER"); await prisma.participant.update({where:{convId_userId:{convId,userId:targetId}},data:{role}}); const targetUser=await prisma.user.findUnique({where:{id:targetId},select:{pseudo:true,publicNumber:true}}); await prisma.message.create({data:{convId,senderId:userId,type:"SYSTEM",content:`${targetUser?.pseudo ?? targetUser?.publicNumber ?? "Un membre"} ${role==="ADMIN"?"est maintenant administrateur":"est redevenu membre"}`}}); return ok({userId:targetId,role}); });
