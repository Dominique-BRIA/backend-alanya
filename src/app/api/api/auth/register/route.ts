import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { ok, fail, handleError } from "@/lib/http";
import { registerSchema } from "@/lib/validation";
import { generateOtpCode, hashOtp } from "@/lib/otp";
import { sendOtpEmail } from "@/lib/mailer";
import { rateLimit, clientIp } from "@/lib/rate-limit";

// POST /api/auth/register
// Démarre l'inscription : génère un code OTP à 6 chiffres et l'envoie par email.
export async function POST(req: NextRequest) {
  try {
    const rl = rateLimit(`register:${clientIp(req)}`, 5, 60_000);
    if (!rl.allowed) return fail("Trop de demandes, réessayez plus tard", 429, "RATE_LIMITED");

    const { email } = registerSchema.parse(await req.json());

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing?.emailVerified && existing.passwordHash) {
      return fail("Un compte existe déjà avec cet email", 409, "EMAIL_TAKEN");
    }

    const code = generateOtpCode();
    const codeHash = await hashOtp(code);
    const expiresAt = new Date(Date.now() + env.otp.ttlMinutes * 60 * 1000);

    // On invalide les anciens codes non consommés pour cet email.
    await prisma.emailVerification.updateMany({
      where: { email, consumed: false },
      data: { consumed: true },
    });
    await prisma.emailVerification.create({ data: { email, codeHash, expiresAt } });

    await sendOtpEmail(email, code);

    return ok({ message: "Code de confirmation envoyé", email });
  } catch (err) {
    return handleError(err);
  }
}
