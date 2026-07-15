import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { blockUserSchema } from "@/lib/validation";

// GET /api/blocked — liste des utilisateurs bloqués par l'utilisateur connecté.
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const blocked = await prisma.blocked.findMany({
    where: { alanyaID: userId },
    orderBy: { dateBlock: "desc" },
    include: {
      blockedUser: {  },
    },
  });

  return ok({
    blocked: blocked.map((b) => ({
      idBlock: b.idBlock,
      idCallerBlock: b.idCallerBlock,
      pseudo: b.blockedUser.pseudo ?? null,
      publicNumber: b.blockedUser.publicNumber,
      avatarUrl: b.blockedUser.avatarUrl ?? null,
      dateBlock: b.dateBlock,
    })),
  });
});

// POST /api/blocked — bloque un utilisateur par son numéro public.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const body = blockUserSchema.parse(await req.json());

  const target = await prisma.user.findUnique({
    where: { publicNumber: body.publicNumber },
  });
  if (!target) return fail("Aucun utilisateur avec ce numéro", 404, "NOT_FOUND");
  if (target.id === userId) return fail("Tu ne peux pas te bloquer toi-même", 400, "SELF");

  const existing = await prisma.blocked.findUnique({
    where: {
      alanyaID_idCallerBlock: { alanyaID: userId, idCallerBlock: target.id },
    },
  });
  if (existing) return fail("Cet utilisateur est déjà bloqué", 409, "ALREADY_BLOCKED");

  const blocked = await prisma.blocked.create({
    data: {
      alanyaID: userId,
      idCallerBlock: target.id,
    },
  });

  return ok(
    {
      idBlock: blocked.idBlock,
      idCallerBlock: blocked.idCallerBlock,
      dateBlock: blocked.dateBlock,
    },
    201,
  );
});
