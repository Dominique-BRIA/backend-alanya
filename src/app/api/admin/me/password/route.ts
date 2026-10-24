import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/password";
import { routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";

/**
 * PUT /api/admin/me/password — `{ currentPassword, newPassword }`.
 *
 * C'est le mot de passe du COMPTE ALANYA de l'administrateur : il change aussi
 * pour l'application, et il est donc haché par la même fonction qu'elle.
 *
 * Toutes les sessions de console de ce compte tombent ensuite, celle-ci
 * comprise : leurs jetons portent l'empreinte de l'ancien mot de passe (voir
 * `session.ts`).
 */
const corpsSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "8 caractères au minimum").max(200),
});

export const PUT = routeAdmin("profile.password", async (req, session) => {
  const corps = corpsSchema.safeParse(await req.json().catch(() => null));
  if (!corps.success) {
    throw new ErreurAdmin(400, "Mot de passe actuel et nouveau mot de passe (8 caractères au moins) requis", "INVALID_PASSWORD");
  }

  const compte = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { passwordHash: true },
  });
  if (!compte) throw new ErreurAdmin(404, "Compte introuvable", "USER_NOT_FOUND");
  if (!compte.passwordHash || !(await verifyPassword(corps.data.currentPassword, compte.passwordHash))) {
    throw new ErreurAdmin(401, "Mot de passe actuel incorrect", "PASSWORD_INCORRECT");
  }

  await prisma.user.update({
    where: { id: session.userId },
    data: { passwordHash: await hashPassword(corps.data.newPassword) },
  });
  return okAdmin({ message: "Mot de passe modifié avec succès" });
});
