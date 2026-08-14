import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { verifyAccessToken } from "@/lib/jwt";
import { hashPassword } from "@/lib/password";
import { issueTokenPair } from "@/modules/auth/tokens";
import { recordAccess } from "@/lib/user-access";

// POST /api/auth/register-dev
// Finalisation de l'inscription Développeur (typeCompte = 4) après vérification OTP.
export async function POST(req: NextRequest) {
  try {
    const header = req.headers.get("authorization");
    if (!header?.startsWith("Bearer ")) return fail("setupToken manquant", 401, "NO_TOKEN");
    const token = header.slice("Bearer ".length).trim();

    let userId: string;
    try {
      const payload = verifyAccessToken(token);
      if (payload.scope !== "setup") return fail("Token invalide", 401, "BAD_SCOPE");
      userId = payload.sub;
    } catch {
      return fail("setupToken invalide ou expiré", 401, "BAD_TOKEN");
    }

    const { password, nom, mobile, idPays, avatarUrl } = await req.json();

    if (!password || password.length < 8) {
      return fail("Le mot de passe doit contenir au moins 8 caractères", 400, "BAD_PASSWORD");
    }
    if (!nom || !nom.trim()) {
      return fail("Le nom est obligatoire", 400, "BAD_NAME");
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.emailVerified) return fail("Compte non vérifié par OTP", 400, "NOT_VERIFIED");

    const passwordHash = await hashPassword(password);

    // Image avatar fallback sur Dicebear si non fournie
    const finalAvatar =
      avatarUrl && avatarUrl.trim()
        ? avatarUrl.trim()
        : `https://api.dicebear.com/7.x/icons/svg?seed=dev_${encodeURIComponent(user.email)}`;

    // Mise à jour de l'utilisateur avec typeCompte = 4 (Développeur)
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        pseudo: nom.trim(),
        nom: nom.trim(),
        mobile: mobile ? mobile.trim() : null,
        idPays: idPays ? Number(idPays) : null,
        avatarUrl: finalAvatar,
        typeCompte: 4, // 4 = Développeur
      },
    });

    // Création ou récupération du compte developer_accounts avec 1 000 crédits offerts
    let devAccount = await prisma.developerAccount.findUnique({
      where: { userId: user.id },
    });

    if (!devAccount) {
      devAccount = await prisma.developerAccount.create({
        data: {
          userId: user.id,
          balanceCredits: 1000,
          holdCredits: 0,
        },
      });

      // Transaction initiale au ledger
      await prisma.devLedger.create({
        data: {
          developerId: devAccount.id,
          amount: 1000,
          type: "PURCHASE",
          status: "SETTLED",
          description: "Bienvenue Développeur Alanya - 1 000 Crédits offerts",
        },
      });
    }

    // Journal d'accès
    await recordAccess(prisma, { userId: user.id, req });

    // Émission du pair de tokens JWT
    const tokens = await issueTokenPair(user.id);

    return ok({
      message: "Compte Développeur créé avec succès",
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        pseudo: updatedUser.pseudo,
        typeCompte: updatedUser.typeCompte,
        avatarUrl: updatedUser.avatarUrl,
      },
      developer: {
        id: devAccount.id,
        balanceCredits: devAccount.balanceCredits.toString(),
        holdCredits: devAccount.holdCredits.toString(),
      },
      tokens,
    });
  } catch (err) {
    return handleError(err);
  }
}
