import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { emailSchema } from "@/lib/validation";
import { generateOtpCode, hashOtp } from "@/lib/otp";
import { sendOtpEmail } from "@/lib/mailer";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { z } from "zod";

const schema = z.object({ email: emailSchema });

/**
 * POST /api/account/email — DEMANDER l'ajout d'une adresse à un compte qui n'en
 * a pas. Envoie le code ; c'est `/api/account/email/verify` qui pose l'adresse.
 *
 * Pourquoi cette route existe : l'identifiant de récupération n'est montré
 * qu'une fois, et un utilisateur qui craint de l'avoir mal noté n'avait aucun
 * second recours. Ajouter une adresse après coup lui en donne un — le même que
 * celui des comptes ouverts avec une adresse.
 *
 * ⚠️ EN DEUX TEMPS, comme l'inscription, et pour la même raison : poser
 * l'adresse dès la demande ferait d'une simple faute de frappe une adresse
 * définitive et non vérifiée sur le compte. Rien n'est écrit tant que le code
 * n'est pas revenu.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const rl = rateLimit(`add-email:${clientIp(req)}`, 5, 60_000);
  if (!rl.allowed) return fail("Trop de demandes, réessayez plus tard", 429, "RATE_LIMITED");

  const { email } = schema.parse(await req.json());

  const moi = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!moi) return fail("Utilisateur introuvable", 404, "NOT_FOUND");
  /*
   * ⚠️ ON N'AJOUTE QUE SUR UN COMPTE SANS ADRESSE, on ne REMPLACE pas.
   *
   * Changer l'adresse d'un compte qui en a déjà une est une autre opération,
   * et une bien plus dangereuse : quiconque emprunte une session ouverte
   * détournerait le moyen de reprise vers sa propre boîte, et le titulaire
   * perdrait son compte sans rien voir. Si le besoin vient, il devra exiger le
   * mot de passe courant ET prévenir l'ancienne adresse.
   */
  if (moi.email !== null) {
    return fail("Ce compte a déjà une adresse", 409, "EMAIL_ALREADY_SET");
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
