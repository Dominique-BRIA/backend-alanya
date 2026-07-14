import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { updateProfileSchema } from "@/lib/validation";

// PATCH /api/account/profile — met à jour le profil de l'utilisateur connecté.
export const PATCH = withAuth(async (req: NextRequest, userId: string) => {
  const data = updateProfileSchema.parse(await req.json());

  const profile = await prisma.profile.upsert({
    where: { userId },
    create: {
      userId,
      displayName: data.pseudo ?? "Utilisateur",
      avatarUrl: data.avatarUrl ?? null,
      statusMsg: data.statusMsg ?? null,
    },
    update: {
      displayName: data.pseudo ?? undefined,
      avatarUrl: data.avatarUrl === undefined ? undefined : data.avatarUrl,
      statusMsg: data.statusMsg === undefined ? undefined : data.statusMsg,
    },
  });

  return ok({
    pseudo: profile.displayName,
    avatarUrl: profile.avatarUrl,
    statusMsg: profile.statusMsg,
  });
});
