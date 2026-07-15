import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { updateProfileSchema } from "@/lib/validation";

// PATCH /api/account/profile — met à jour le profil de l'utilisateur connecté.
// F4 : écrit directement dans users (plus de table profiles).
export const PATCH = withAuth(async (req: NextRequest, userId: string) => {
  const data = updateProfileSchema.parse(await req.json());

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(data.pseudo !== undefined && { pseudo: data.pseudo }),
      ...(data.avatarUrl !== undefined && { avatarUrl: data.avatarUrl }),
      ...(data.statusMsg !== undefined && { statusMsg: data.statusMsg }),
    },
  });

  return ok({
    pseudo: user.pseudo,
    avatarUrl: user.avatarUrl,
    statusMsg: user.statusMsg,
  });
});
