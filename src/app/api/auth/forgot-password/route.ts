import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { emailSchema } from "@/lib/validation";
import { generateOtpCode, hashOtp } from "@/lib/otp";
import { sendOtpEmail } from "@/lib/mailer";
import { rateLimit, clientIp } from "@/lib/rate-limit";

// POST /api/auth/forgot-password
// Déclenche l'envoi d'un code OTP si l'email existe.
export async function POST(req: NextRequest) {
  try {
    const rl = rateLimit(`forgot:${clientIp(req)}`, 5, 60_000); // 5 req/min
    if (!rl.allowed) return fail("Trop de tentatives, réessayez plus tard", 429, "RATE_LIMITED");

    const email = emailSchema.parse((await req.json()).email);
    
    const user = await prisma.user.findUnique({ where: { email } });

    // Pour des raisons de sécurité, on renvoie toujours un succès, même si l'email n'existe pas.
    // Cela empêche les attaquants de deviner quels emails sont enregistrés.
    if (user) {
      const code = generateOtpCode();
      const codeHash = await hashOtp(code);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      await prisma.emailVerification.create({
        data: { email, codeHash, expiresAt },
      });

      // ATTEND que l'email soit parti (sinon Vercel tue la fonction serverless trop tôt)
      const envoi = await sendOtpEmail(email, code);
      /*
       * 🔴 ICI, ON NE REMONTE PAS L'ÉCHEC — à la différence de l'inscription.
       *
       * Cette route répond volontairement « si ce compte existe… » pour ne pas
       * révéler quels courriels sont inscrits. Or un envoi n'est TENTÉ que si le
       * compte existe : répondre 502 sur un échec d'envoi dirait donc « ce
       * compte existe », et rendrait l'énumération possible par une simple
       * panne de SMTP. L'échec est journalisé par le mailer, et l'utilisateur
       * reprend le parcours — c'est le prix assumé de la non-divulgation.
       */
      if (!envoi.remis) {
        console.error("[forgot-password] code non remis, réponse neutre maintenue");
      }
    }

    return ok({ message: "Si ce compte existe, un email lui a été envoyé." });
  } catch (err) {
    return handleError(err);
  }
}
