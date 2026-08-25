import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { emailSchema } from "@/lib/validation";
import { generateOtpCode, hashOtp } from "@/lib/otp";
import { sendOtpEmail } from "@/lib/mailer";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { verifyPassword } from "@/lib/password";
import { z } from "zod";

const schema = z.object({
  email: emailSchema,
  /**
   * 🔴 LE MOT DE PASSE COURANT EST EXIGÉ, pour ajouter comme pour remplacer.
   *
   * L'adresse EST un moyen de reprendre le compte. Sans ce contrôle, quiconque
   * emprunte une session ouverte — un téléphone déverrouillé posé sur une table,
   * un navigateur laissé connecté — y inscrit sa propre adresse, puis reprend le
   * compte tranquillement plus tard par « mot de passe oublié ». Le vol ne
   * demanderait ni le mot de passe, ni de rester connecté.
   *
   * Exigé sur les DEUX cas et pas seulement sur le remplacement : la menace est
   * la même, et une seule règle vaut mieux que deux dont on finirait par se
   * demander laquelle s'applique.
   */
  password: z.string().min(1, "Mot de passe requis"),
});

/**
 * POST /api/account/email — DEMANDER l'ajout OU LE REMPLACEMENT de l'adresse.
 * Envoie le code ; c'est `/api/account/email/verify` qui pose l'adresse.
 *
 * Deux besoins, un seul parcours :
 *
 *   - **AJOUTER** — l'identifiant de récupération n'est montré qu'une fois, et
 *     qui craint de l'avoir mal noté n'avait aucun second recours ;
 *   - **REMPLACER** (demandé le 25/08/2026) — on perd l'accès à une boîte, on
 *     en ouvre une autre, et le compte doit pouvoir suivre. Sans cela, l'adresse
 *     de reprise devient un piège : elle désigne une boîte que son titulaire ne
 *     relève plus.
 *
 * ⚠️ EN DEUX TEMPS, comme l'inscription, et pour la même raison : poser
 * l'adresse dès la demande ferait d'une simple faute de frappe une adresse
 * définitive sur le compte — et, dans le cas du remplacement, ferait PERDRE
 * l'ancienne au passage. Rien n'est écrit tant que le code n'est pas revenu.
 *
 * ⚠️ LE CODE PART SUR LA NOUVELLE ADRESSE, jamais sur l'ancienne : c'est la
 * nouvelle qu'il s'agit de prouver joignable, et l'ancienne est justement celle
 * que l'utilisateur ne relève plus.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const rl = rateLimit(`add-email:${clientIp(req)}`, 5, 60_000);
  if (!rl.allowed) return fail("Trop de demandes, réessayez plus tard", 429, "RATE_LIMITED");

  const { email, password } = schema.parse(await req.json());

  const moi = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, passwordHash: true },
  });
  if (!moi) return fail("Utilisateur introuvable", 404, "NOT_FOUND");

  /*
   * Le mot de passe courant, AVANT tout le reste.
   *
   * ⚠️ Un compte sans `passwordHash` est une inscription jamais terminée : il
   * n'y a rien à comparer, et laisser passer reviendrait à ne pas contrôler du
   * tout. On refuse.
   */
  if (!moi.passwordHash) {
    return fail("Mot de passe incorrect", 403, "BAD_PASSWORD");
  }
  if (!(await verifyPassword(password, moi.passwordHash))) {
    return fail("Mot de passe incorrect", 403, "BAD_PASSWORD");
  }

  // Remplacer une adresse par elle-même n'a pas de sens, et ferait envoyer un
  // code pour rien. Le dire vaut mieux que de laisser l'utilisateur relever sa
  // boîte pour confirmer ce qui est déjà vrai.
  if (moi.email === email) {
    return fail("Cette adresse est déjà celle du compte", 409, "EMAIL_UNCHANGED");
  }

  // L'adresse ne doit pas déjà servir à un autre compte : la colonne est
  // unique, et sans ce contrôle l'échec ne surviendrait qu'à la confirmation,
  // après que l'utilisateur a reçu et saisi son code pour rien.
  const prise = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (prise) return fail("Un compte existe déjà avec cet email", 409, "EMAIL_TAKEN");

  const code = generateOtpCode();
  const codeHash = await hashOtp(code);
  const expiresAt = new Date(Date.now() + env.otp.ttlMinutes * 60 * 1000);

  await prisma.emailVerification.updateMany({
    where: { email, consumed: false },
    data: { consumed: true },
  });
  await prisma.emailVerification.create({ data: { email, codeHash, expiresAt } });

  // Comme à l'inscription, l'échec d'envoi est SIGNALÉ : ici la non-divulgation
  // n'a pas lieu d'être — c'est l'utilisateur lui-même qui donne son adresse,
  // il n'y a rien à lui cacher, et le taire le laisserait attendre un courriel
  // qui n'arrivera jamais.
  const envoi = await sendOtpEmail(email, code);
  if (!envoi.remis) {
    return fail(
      "Impossible d'envoyer le code de confirmation. Réessayez dans un instant.",
      502,
      "MAIL_NON_REMIS",
    );
  }

  return ok({ message: "Code de confirmation envoyé", email });
});
