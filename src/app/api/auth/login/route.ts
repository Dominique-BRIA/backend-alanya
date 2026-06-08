import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { loginSchema } from "@/lib/validation";
import { verifyPassword } from "@/lib/password";
import { issueTokenPair } from "@/modules/auth/tokens";
import { rateLimit, clientIp } from "@/lib/rate-limit";

// POST /api/auth/login
// Connexion par email OU par numéro public à 6 chiffres + mot de passe.
export async function POST(req: NextRequest) {
  try {
    const rl = rateLimit(`login:${clientIp(req)}`, 5, 60_000);
    if (!rl.allowed) return fail("Trop de tentatives, réessayez plus tard", 429, "RATE_LIMITED");

    const { identifier, password } = loginSchema.parse(await req.json());

    const isPublicNumber = /^\d{6}$/.test(identifier);
    const user = await prisma.user.findFirst({
      where: isPublicNumber
        ? { publicNumber: identifier }
        : { email: identifier.toLowerCase() },
      include: { profile: true },
    });

    // Message générique pour ne pas révéler l'existence d'un compte.
    if (!user || !user.passwordHash) {
      return fail("Identifiants incorrects", 401, "BAD_CREDENTIALS");
    }
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) return fail("Identifiants incorrects", 401, "BAD_CREDENTIALS");

    const tokens = await issueTokenPair(user.id);
    return ok({
      user: {
        id: user.id,
        email: user.email,
        publicNumber: user.publicNumber,
        pseudo: user.profile?.displayName ?? null,
        avatarUrl: user.profile?.avatarUrl ?? null,
      },
      ...tokens,
    });
  } catch (err) {
    return handleError(err);
  }
}
