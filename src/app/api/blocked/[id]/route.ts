import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { mirrorContactBlock } from "@/lib/blocking";
import { nomAffichage } from "@/lib/display-name.mjs";

// DELETE /api/blocked/:id — débloque un utilisateur (id = idBlock).
export const DELETE = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const idBlock = Number((await ctx.params).id);
  if (isNaN(idBlock) || idBlock <= 0) return fail("ID invalide", 400, "BAD_ID");

  const blocked = await prisma.blocked.findUnique({
    where: { idBlock },
  });

  if (!blocked) return fail("Blocage introuvable", 404, "NOT_FOUND");
  if (blocked.alanyaID !== userId) {
    return fail("Accès refusé", 403, "FORBIDDEN");
  }

  await prisma.blocked.delete({ where: { idBlock } });

  // Miroir : lève aussi le flag Contact.isBlocked si la personne est un contact.
  await mirrorContactBlock(blocked.alanyaID, blocked.idCallerBlock, false);

  return ok({ message: "Utilisateur débloqué", idBlock });
});

// GET /api/blocked/:id — vérifie si un utilisateur spécifique est bloqué.
export const GET = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const idBlock = Number((await ctx.params).id);
  if (isNaN(idBlock) || idBlock <= 0) return fail("ID invalide", 400, "BAD_ID");

  const blocked = await prisma.blocked.findUnique({
    where: { idBlock },
    include: { blockedUser: true },
  });

  if (!blocked) return fail("Blocage introuvable", 404, "NOT_FOUND");
  if (blocked.alanyaID !== userId) return fail("Accès refusé", 403, "FORBIDDEN");

  return ok({
    idBlock: blocked.idBlock,
    idCallerBlock: blocked.idCallerBlock,
    pseudo: nomAffichage(blocked.blockedUser),
    publicNumber: blocked.blockedUser.publicNumber,
    dateBlock: blocked.dateBlock,
  });
});
