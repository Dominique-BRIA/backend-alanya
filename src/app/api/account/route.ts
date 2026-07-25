import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { verifyPassword } from "@/lib/password";

// DELETE /api/account — supprime définitivement le compte de l'utilisateur
// connecté. Body { password }. Vérifie le mot de passe avant suppression.
// La suppression de la ligne users cascade sur ses données (messages,
// participations, contacts, statuts, réactions, favoris, etc.).
export const DELETE = withAuth(async (req: NextRequest, userId: string) => {
  let password = "";
  try {
    const body = await req.json();
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    // corps absent → password vide → rejeté ci-dessous
  }

  if (!password) {
    return fail("Mot de passe requis pour supprimer le compte", 400, "MISSING_PASSWORD");
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!user) return fail("Compte introuvable", 404, "NOT_FOUND");
  if (!user.passwordHash) {
    return fail("Aucun mot de passe défini sur ce compte", 400, "NO_PASSWORD");
  }

  const okPass = await verifyPassword(password, user.passwordHash);
  if (!okPass) return fail("Mot de passe incorrect", 400, "BAD_CREDENTIALS");

  await prisma.user.delete({ where: { id: userId } });

  return ok({ message: "Compte supprimé" });
});
