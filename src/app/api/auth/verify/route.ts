import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { verifySchema } from "@/lib/validation";
import { verifyOtp } from "@/lib/otp";
import { signSetupToken } from "@/lib/jwt";
import { generateUniquePublicNumber } from "@/lib/publicNumber";
import { rateLimit, clientIp } from "@/lib/rate-limit";

const MAX_ATTEMPTS = 5;

// POST /api/auth/verify
// Vérifie le code OTP. En cas de succès, crée (ou retrouve) l'utilisateur avec son
// numéro public à 6 chiffres et renvoie un « setupToken » pour l'étape pseudo + mot de passe.
export async function POST(req: NextRequest) {
  try {
    const rl = rateLimit(`verify:${clientIp(req)}`, 10, 60_000);
    if (!rl.allowed) return fail("Trop de tentatives, réessayez plus tard", 429, "RATE_LIMITED");

    const { email, code } = verifySchema.parse(await req.json());

    const record = await prisma.emailVerification.findFirst({
      where: { email, consumed: false },
      orderBy: { createdAt: "desc" },
    });
    if (!record) return fail("Aucun code en attente pour cet email", 400, "NO_OTP");
    if (record.expiresAt < new Date()) return fail("Code expiré", 400, "OTP_EXPIRED");
    if (record.attempts >= MAX_ATTEMPTS) {
      return fail("Trop de tentatives, redemandez un code", 429, "TOO_MANY_ATTEMPTS");
    }

    const valid = await verifyOtp(code, record.codeHash);
    if (!valid) {
      await prisma.emailVerification.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      return fail("Code incorrect", 400, "OTP_INVALID");
    }

    await prisma.emailVerification.update({
      where: { id: record.id },
      data: { consumed: true },
    });

    // Crée l'utilisateur s'il n'existe pas, en générant son numéro public.
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      const publicNumber = await generateUniquePublicNumber();
      user = await prisma.user.create({
        data: { email, emailVerified: true, publicNumber },
      });
    } else if (!user.emailVerified) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });
    }

    const setupToken = signSetupToken(user.id);
    return ok({
      message: "Email vérifié",
      setupToken,
      publicNumber: user.publicNumber,
      needsSetup: !user.passwordHash,
    });
  } catch (err) {
    return handleError(err);
  }
}
