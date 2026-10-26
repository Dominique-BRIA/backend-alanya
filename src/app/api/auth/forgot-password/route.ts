import { type NextRequest } from "next/server";
import { refuserSiMaintenance } from "@/lib/maintenance";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { emailSchema } from "@/lib/validation";
import { generateOtpCode, hashOtp } from "@/lib/otp";
import { MOTIF, sendOtpEmail } from "@/lib/mailer";
import { rateLimit, clientIp } from "@/lib/rate-limit";

// POST /api/auth/forgot-password
// Envoie un code OTP à l'adresse d'un compte existant.
export async function POST(req: NextRequest) {
  try {
    await refuserSiMaintenance();
    const rl = await rateLimit(`forgot:${clientIp(req)}`, 5, 60_000); // 5 req/min
    if (!rl.allowed) return fail("Trop de tentatives, réessayez plus tard", 429, "RATE_LIMITED");

    const email = emailSchema.parse((await req.json()).email);

    const user = await prisma.user.findUnique({ where: { email } });

    /*
     * 🔴 UN COMPTE INCONNU EST SIGNALÉ (26/10/2026, demande du user).
     *
     * La route répondait toujours « si ce compte existe, un email lui a été
     * envoyé », pour ne pas révéler quels courriels sont inscrits. Mais depuis
     * que l'adresse est facultative (25/08/2026), beaucoup de comptes n'en ont
     * pas : leurs titulaires tapaient une adresse, lisaient « code envoyé » et
     * n'attendaient rien. On le dit désormais ; la limite de 5 demandes par
     * minute et par IP freine qui voudrait sonder les adresses.
     */
    if (!user) {
      return fail("Aucun compte n'est associé à cet email.", 404, "EMAIL_INCONNU");
    }

    const code = generateOtpCode();
    const codeHash = await hashOtp(code);
    const dureeMinutes = 10;
    const expiresAt = new Date(Date.now() + dureeMinutes * 60 * 1000);

    await prisma.emailVerification.create({
      data: { email, codeHash, expiresAt },
    });

    // ATTEND que l'email soit parti (sinon Vercel tue la fonction serverless trop tôt)
    /*
     * ⚠️ LA DURÉE ANNONCÉE EST CELLE DU CODE. Le courriel affichait la durée
     * générale (`OTP_TTL_MINUTES`) alors que ce code-ci expire en 10 minutes :
     * dès que les deux différaient, le message promettait un délai faux.
     */
    const envoi = await sendOtpEmail(email, code, dureeMinutes, {
      motif: MOTIF.MOT_DE_PASSE,
      langue: req.headers.get("accept-language"),
    });
    // L'existence du compte n'étant plus tue, l'échec d'envoi remonte aussi,
    // comme à l'inscription.
    if (!envoi.remis) {
      return fail(
        "Impossible d'envoyer le code. Réessayez dans un instant.",
        502,
        "MAIL_NON_REMIS",
      );
    }

    return ok({ message: "Un code a été envoyé à cet email." });
  } catch (err) {
    return handleError(err);
  }
}
