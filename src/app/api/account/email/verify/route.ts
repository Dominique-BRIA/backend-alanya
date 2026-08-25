import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { verifySchema } from "@/lib/validation";
import { verifyOtp } from "@/lib/otp";
import { rateLimit, clientIp } from "@/lib/rate-limit";

const MAX_ATTEMPTS = 5;

/**
 * POST /api/account/email/verify — CONFIRMER l'adresse demandée juste avant, et
 * la poser sur le compte.
 *
 * Second temps de `POST /api/account/email`. Même contrôle du code que
 * `/api/auth/verify` : plafond d'essais, expiration, consommation à l'usage.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const rl = rateLimit(`add-email-verify:${clientIp(req)}`, 10, 60_000);
  if (!rl.allowed) return fail("Trop de tentatives, réessayez plus tard", 429, "RATE_LIMITED");

  const { email, code } = verifySchema.parse(await req.json());

  const moi = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!moi) return fail("Utilisateur introuvable", 404, "NOT_FOUND");
  /*
   * ⚠️ LE REFUS « ce compte a déjà une adresse » A ÉTÉ RETIRÉ (25/08/2026).
   *
   * Cette route ne servait qu'à AJOUTER. Elle sert désormais aussi à REMPLACER :
   * on perd l'accès à une boîte, on en ouvre une autre, et le compte doit
   * pouvoir suivre — sans quoi l'adresse de reprise finit par désigner une
   * boîte que son titulaire ne relève plus, ce qui est pire que pas d'adresse
   * du tout.
   *
   * Ce qui protège l'opération n'est PAS ce refus, c'est le mot de passe courant
   * exigé au premier temps (`POST /api/account/email`). Sans lui, une session
   * empruntée suffisait à détourner le moyen de reprise.
   *
   * ⚠️ Le mot de passe n'est PAS redemandé ici : il l'a été pour obtenir le
   * code, et c'est la possession du code — envoyé sur la nouvelle adresse — qui
   * fait la preuve à ce second temps. Le redemander n'ajouterait rien, sinon
   * une saisie de plus au moment le plus fragile du parcours.
   */

  const record = await prisma.emailVerification.findFirst({
    where: { email, consumed: false },
    orderBy: { createdAt: "desc" },
  });
  if (!record) return fail("Aucun code en attente pour cet email", 400, "NO_OTP");
  if (record.expiresAt < new Date()) return fail("Code expiré", 400, "OTP_EXPIRED");
  if (record.attempts >= MAX_ATTEMPTS) {
    return fail("Trop de tentatives, redemandez un code", 429, "TOO_MANY_ATTEMPTS");
  }

  const valide = await verifyOtp(code, record.codeHash);
  if (!valide) {
    await prisma.emailVerification.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    return fail("Code incorrect", 400, "OTP_INVALID");
  }

  /*
   * ⚠️ LE CONTRÔLE D'UNICITÉ EST REFAIT ICI, et ce n'est pas une redite : entre
   * la demande et la confirmation, il s'écoule le temps de relever un courriel.
   * Quelqu'un d'autre a pu inscrire cette adresse entre-temps. Sans ce second
   * contrôle, l'écriture ci-dessous échouerait sur la contrainte d'unicité et
   * rendrait une 500 illisible là où un 409 explique la situation.
   */
  const prise = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (prise) return fail("Un compte existe déjà avec cet email", 409, "EMAIL_TAKEN");

  /*
   * 🔴 `idRecuperation` EST CONSERVÉ, pas effacé.
   *
   * Le compte garde DEUX moyens de reprise, et c'est voulu : l'utilisateur a
   * peut-être noté son code sur un papier qu'il garde, et le lui retirer parce
   * qu'il pose une adresse remplacerait un recours par un autre au lieu d'en
   * ajouter un.
   *
   * Vrai aussi lors d'un REMPLACEMENT : on ne change que l'adresse. C'est déjà
   * l'opération la plus délicate du compte, ce n'est pas le moment d'en profiter
   * pour retirer l'autre porte de sortie.
   */
  await prisma.user.update({
    where: { id: userId },
    data: { email, emailVerified: true },
  });
  await prisma.emailVerification.update({
    where: { id: record.id },
    data: { consumed: true },
  });

  return ok({ message: "Adresse confirmée", email });
});
