import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { z } from "zod";
import { verifyOtp } from "@/lib/otp";
import { hashPassword } from "@/lib/password";
import { rateLimit, clientIp } from "@/lib/rate-limit";

const schema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: z.string().trim().regex(/^\d{6}$/, "Le code doit comporter 6 chiffres"),
  password: z.string().min(8, "Le mot de passe doit faire au moins 8 caractères").max(128),
});

const MAX_ATTEMPTS = 5;

// POST /api/auth/reset-password
// Vérifie le code OTP de réinitialisation et met à jour le mot de passe.
export async function POST(req: NextRequest) {
  try {
    const rl = rateLimit(`reset:${clientIp(req)}`, 10, 60_000);
    if (!rl.allowed) return fail("Trop de tentatives, réessayez plus tard", 429, "RATE_LIMITED");

    const { email, code, password } = schema.parse(await req.json());

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

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return fail("Compte introuvable", 404, "NOT_FOUND");

    const passwordHash = await hashPassword(password);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    // Marque le code comme consommé pour éviter la réutilisation.
    await prisma.emailVerification.update({
      where: { id: record.id },
      data: { consumed: true },
    });

    // (Optionnel) Révoquer toutes les sessions actives de cet utilisateur
    await prisma.refreshToken.updateMany({
      where: { userId: user.id, revoked: false },
      data: { revoked: true },
    });

    return ok({ message: "Mot de passe réinitialisé avec succès" });
  } catch (err) {
    return handleError(err);
  }
}
