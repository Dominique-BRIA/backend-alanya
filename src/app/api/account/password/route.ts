import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { hashPassword, verifyPassword } from "@/lib/password";

// POST /api/account/password — change le mot de passe de l'utilisateur connecté.
// Body { currentPassword, newPassword }. Vérifie l'ancien mot de passe.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const { currentPassword, newPassword } = await req.json();

  if (typeof currentPassword !== "string" || currentPassword.length === 0) {
    return fail("Mot de passe actuel requis", 400, "MISSING_CURRENT");
  }
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return fail(
      "Le nouveau mot de passe doit contenir au moins 8 caractères",
      400,
      "WEAK_PASSWORD",
    );
  }
  if (currentPassword === newPassword) {
    return fail(
      "Le nouveau mot de passe doit être différent de l'actuel",
      400,
      "SAME_PASSWORD",
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!user || !user.passwordHash) {
    return fail("Aucun mot de passe défini sur ce compte", 400, "NO_PASSWORD");
  }

  const okPass = await verifyPassword(currentPassword, user.passwordHash);
  if (!okPass) return fail("Mot de passe actuel incorrect", 400, "BAD_CREDENTIALS");

  const newHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: newHash },
  });

  return ok({ message: "Mot de passe modifié" });
});
