import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { motDePasseValide, routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";

/**
 * PUT /api/admin/me/password — `{ currentPassword, newPassword }`.
 *
 * Seul un compte de la table `Root` peut changer son mot de passe ici. Celui
 * du compte maître vit dans l'environnement du serveur (`SUPER_ROOT_PASSWORD`) :
 * aucune route ne doit pouvoir l'écrire.
 *
 * ⚠️ HACHAGE À 10 TOURS, COMME alanyaCenter (`rootController`, `bcrypt.hash(…, 10)`).
 * La table est partagée : le même mot de passe doit s'ouvrir des deux côtés.
 * bcryptjs produit des `$2a$`/`$2b$` que leur `bcrypt` relit sans peine.
 *
 * Toutes les sessions de ce compte tombent ensuite, celle-ci comprise : leurs
 * jetons portent l'empreinte de l'ancien mot de passe (voir `session.ts`).
 */
const corpsSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "8 caractères au minimum").max(200),
});

export const PUT = routeAdmin("profile.password", async (req, session) => {
  if (session.isMaster) {
    throw new ErreurAdmin(
      400,
      "Le mot de passe du compte maître se change dans la configuration du serveur",
      "MASTER_PASSWORD_IN_ENV",
    );
  }
  const corps = corpsSchema.safeParse(await req.json().catch(() => null));
  if (!corps.success) {
    throw new ErreurAdmin(400, "Mot de passe actuel et nouveau mot de passe (8 caractères au moins) requis", "INVALID_PASSWORD");
  }

  const root = await prisma.root.findUnique({ where: { idRoot: session.idRoot as number } });
  if (!root) throw new ErreurAdmin(404, "Compte introuvable", "USER_NOT_FOUND");
  if (!(await motDePasseValide(corps.data.currentPassword, root.password))) {
    throw new ErreurAdmin(401, "Mot de passe actuel incorrect", "PASSWORD_INCORRECT");
  }

  await prisma.root.update({
    where: { idRoot: root.idRoot },
    data: { password: await bcrypt.hash(corps.data.newPassword, 10) },
  });
  return okAdmin({ message: "Mot de passe modifié avec succès" });
});
