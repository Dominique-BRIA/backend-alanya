import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { ALANYA_ID_REGEX, loginSchema } from "@/lib/validation";
import { verifyPassword } from "@/lib/password";
import { issueTokenPair } from "@/modules/auth/tokens";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { recordAccess } from "@/lib/user-access";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";

// POST /api/auth/login
// Connexion par email OU par numéro public (6 ou 8 chiffres) + mot de passe.
export async function POST(req: NextRequest) {
  try {
    const rl = rateLimit(`login:${clientIp(req)}`, 5, 60_000);
    if (!rl.allowed) return fail("Trop de tentatives, réessayez plus tard", 429, "RATE_LIMITED");

    const { identifier, password, deviceId } = loginSchema.parse(await req.json());

    // Un identifiant est un publicNumber s'il n'est fait que de chiffres, dans
    // les bornes admises. La règle vit dans `validation.ts` et n'est plus
    // recopiée ici : les comptes de 3, 4 ou 10 chiffres (centres d'appels,
    // numéros courts) ne pouvaient pas se connecter, leur identifiant étant
    // cherché du côté des adresses email.
    const isPublicNumber = ALANYA_ID_REGEX.test(identifier);
    const user = await prisma.user.findFirst({
      where: isPublicNumber
        ? { publicNumber: identifier }
        : { email: identifier.toLowerCase() },
    });

    // Message générique pour ne pas révéler l'existence d'un compte.
    if (!user || !user.passwordHash) {
      return fail("Identifiants incorrects", 401, "BAD_CREDENTIALS");
    }
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) return fail("Identifiants incorrects", 401, "BAD_CREDENTIALS");

    // F6 : vérifie si le compte est exclu
    if (user.exclus === 1) {
      return fail("Votre compte a été suspendu", 403, "EXCLUDED");
    }

    // F5 : marque l'utilisateur en ligne
    await prisma.user.update({
      where: { id: user.id },
      data: { isOnline: 1, lastSeen: new Date() },
    });

    // Journal des connexions : trace horodatee, jamais bloquante.
    await recordAccess(prisma, { userId: user.id, req });

    const tokens = await issueTokenPair(user.id, deviceId);
    return ok({
      user: {
        id: user.id,
        email: user.email,
        publicNumber: user.publicNumber,
        pseudo: nomAffichage(user),
        avatarUrl: avatarPublicUrl(user.avatarUrl ?? null),
        isOnline: 1,
      },
      ...tokens,
    });
  } catch (err) {
    return handleError(err);
  }
}
