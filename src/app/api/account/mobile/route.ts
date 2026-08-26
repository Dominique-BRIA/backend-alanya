import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { verifyPassword } from "@/lib/password";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { normaliserTelephone } from "@/lib/telephone.mjs";
import { z } from "zod";

const schema = z.object({
  /**
   * 🔴 LE MOT DE PASSE COURANT EST EXIGÉ (demande du user).
   *
   * Le numéro de téléphone identifie la personne auprès de ses contacts, et
   * `users.mobile` est UNIQUE : le changer, c'est se réattribuer une identité
   * que quelqu'un pourrait chercher. Sans ce contrôle, une session empruntée —
   * un téléphone déverrouillé posé sur une table — suffirait à le faire.
   */
  password: z.string().min(1, "Mot de passe requis"),
  /**
   * ⚠️ PAS DE FORME IMPOSÉE ICI : la saisie arrive telle que l'utilisateur l'a
   * tapée, souvent formatée « 6 91 23 45 67 » puisque c'est ainsi que les
   * clients l'affichent. C'est `normaliserTelephone` qui tranche, plus bas —
   * la même fonction qu'à l'inscription, pour que les deux portes produisent
   * exactement la même chaîne en base.
   */
  mobile: z.string().trim().min(1, "Numéro requis").max(30),
  /**
   * Le pays DE LA LIGNE, quand il diffère de celui du compte.
   *
   * 🔴 CE N'EST PAS LE PAYS DU COMPTE, et il n'y est jamais écrit.
   *
   * Les deux se confondent souvent, mais pas toujours : on vit dans un pays et
   * on garde une ligne d'un autre. C'est même la raison pour laquelle changer
   * de pays ne touche pas au numéro. Normaliser un numéro camerounais avec
   * l'indicatif français d'un compte expatrié produisait « +33691234567 » — un
   * numéro que personne ne peut appeler.
   *
   * Il ne sert QU'À la normalisation. Absent, on retombe sur le pays du compte,
   * qui reste le cas le plus fréquent.
   */
  idPaysNumero: z.number().int().positive().optional(),
});

/**
 * POST /api/account/mobile — changer SON NUMÉRO DE TÉLÉPHONE.
 *
 * 🔴 CETTE ROUTE NE TOUCHE PAS À L'ALANYA ID, et c'est la règle qui compte ici.
 *
 * `publicNumber` — le numéro attribué à l'inscription — est l'IDENTITÉ du
 * compte : c'est lui que les contacts ont enregistré, lui qu'on compose pour
 * appeler, lui qui sert d'identifiant de connexion. Il ne change jamais. Ce que
 * cette route modifie est `users.mobile`, le numéro de ligne déclaré par
 * l'utilisateur, qui n'est qu'une information de contact.
 *
 * Confondre les deux détruirait le compte : les correspondants garderaient un
 * Alanya ID qui ne mène plus nulle part.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const rl = rateLimit(`change-mobile:${clientIp(req)}`, 5, 60_000);
  if (!rl.allowed) return fail("Trop de demandes, réessayez plus tard", 429, "RATE_LIMITED");

  const { password, mobile, idPaysNumero } = schema.parse(await req.json());

  const moi = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, mobile: true, pays: { select: { prefix: true } } },
  });
  if (!moi) return fail("Utilisateur introuvable", 404, "NOT_FOUND");

  // Un compte sans `passwordHash` est une inscription jamais terminée : il n'y
  // a rien à comparer, et laisser passer reviendrait à ne pas contrôler.
  if (!moi.passwordHash || !(await verifyPassword(password, moi.passwordHash))) {
    return fail("Mot de passe incorrect", 403, "BAD_PASSWORD");
  }

  /*
   * L'indicatif qui sert à normaliser : celui du pays DE LA LIGNE si le client
   * l'a précisé, sinon celui du compte.
   *
   * 🔴 LE PAYS DE LA LIGNE N'EST JAMAIS ÉCRIT SUR LE COMPTE. Il ne traverse
   * cette route que pour donner le bon indicatif ; `users.idPays` se change
   * ailleurs, et changer de pays ne doit pas changer de numéro.
   *
   * ⚠️ Si le compte n'a pas de pays et que rien n'est précisé, l'indicatif est
   * vide : un numéro national ressortira sans indicatif. C'est assumé — mieux
   * vaut enregistrer ce que la personne a tapé que lui coller un indicatif
   * deviné.
   */
  let prefixe = moi.pays?.prefix ?? "";
  if (idPaysNumero != null) {
    const paysLigne = await prisma.pays.findUnique({
      where: { idPays: idPaysNumero },
      select: { prefix: true },
    });
    if (!paysLigne) return fail("Pays introuvable", 404, "PAYS_NOT_FOUND");
    prefixe = paysLigne.prefix;
  }
  const normalise = normaliserTelephone(mobile, prefixe);
  if (normalise === "") return fail("Numéro invalide", 400, "BAD_MOBILE");

  // Rien à faire, et le dire : renvoyer un succès muet laisserait croire à un
  // changement qui n'a pas eu lieu.
  if (normalise === moi.mobile) {
    return fail("Ce numéro est déjà celui du compte", 409, "MOBILE_UNCHANGED");
  }

  /*
   * ⚠️ LA COLONNE EST UNIQUE. Sans ce contrôle, l'écriture échouerait sur la
   * contrainte et rendrait une 500 illisible là où un 409 explique — et
   * l'utilisateur croirait à une panne alors que son numéro est simplement
   * déjà porté par un autre compte.
   */
  const prise = await prisma.user.findFirst({
    where: { mobile: normalise, NOT: { id: userId } },
    select: { id: true },
  });
  if (prise) return fail("Ce numéro est déjà utilisé par un autre compte", 409, "MOBILE_TAKEN");

  await prisma.user.update({ where: { id: userId }, data: { mobile: normalise } });

  // Le numéro TEL QU'ENREGISTRÉ est renvoyé : le client affiche ce que la base
  // contient, et non ce que l'utilisateur a tapé.
  return ok({ mobile: normalise });
});
