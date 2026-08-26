import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { verifyPassword } from "@/lib/password";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { z } from "zod";

const schema = z.object({
  password: z.string().min(1, "Mot de passe requis"),
});

/**
 * POST /api/account/verify-password — le mot de passe de CE compte est-il celui-ci ?
 *
 * 🔴 CETTE ROUTE NE DONNE AUCUN DROIT ET NE MODIFIE RIEN. Elle sert aux écrans
 * qui se ferment derrière une confirmation : le client demande le mot de passe
 * AVANT d'ouvrir l'écran de changement de numéro, plutôt que de le découvrir
 * faux à l'enregistrement, une fois le formulaire rempli.
 *
 * ⚠️ ELLE NE REMPLACE PAS LE CONTRÔLE DE L'ÉCRITURE. `POST /api/account/mobile`
 * revérifie le mot de passe pour son propre compte : un client peut toujours
 * sauter cet appel, et une porte côté client n'est pas une protection. Ce qui
 * protège, c'est le contrôle au moment d'écrire — celui-ci n'est là que pour
 * dire non tout de suite.
 *
 * ⚠️ C'EST UN ORACLE À MOT DE PASSE, et il faut le traiter comme tel : sans
 * limite, il permettrait d'essayer des mots de passe en boucle sur un jeton
 * volé. La limite est donc SERRÉE et porte sur le COMPTE autant que sur l'IP —
 * changer de réseau ne doit pas rendre les essais gratuits, et attaquer depuis
 * une seule IP ne doit pas non plus bloquer les autres comptes.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const parCompte = rateLimit(`verify-password:u:${userId}`, 5, 60_000);
  if (!parCompte.allowed) {
    return fail("Trop de tentatives, réessayez plus tard", 429, "RATE_LIMITED");
  }
  const parIp = rateLimit(`verify-password:ip:${clientIp(req)}`, 20, 60_000);
  if (!parIp.allowed) {
    return fail("Trop de tentatives, réessayez plus tard", 429, "RATE_LIMITED");
  }

  const { password } = schema.parse(await req.json());

  const moi = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!moi) return fail("Utilisateur introuvable", 404, "NOT_FOUND");

  // Un compte sans `passwordHash` est une inscription jamais terminée : il n'y
  // a rien à comparer, et laisser passer reviendrait à ne pas contrôler.
  if (!moi.passwordHash || !(await verifyPassword(password, moi.passwordHash))) {
    return fail("Mot de passe incorrect", 403, "BAD_PASSWORD");
  }

  return ok({ verifie: true });
});
