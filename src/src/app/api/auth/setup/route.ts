import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { setupSchema } from "@/lib/validation";
import { hashPassword } from "@/lib/password";
import { verifyAccessToken } from "@/lib/jwt";
import { issueTokenPair } from "@/modules/auth/tokens";

// POST /api/auth/setup
// Étape finale d'inscription : choix du pseudo + mot de passe + pays.
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

    const { pseudo, password, nom, idPays } = setupSchema.parse(await req.json());

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.emailVerified) return fail("Compte non vérifié", 400, "NOT_VERIFIED");
    if (user.passwordHash) return fail("Compte déjà configuré", 409, "ALREADY_SETUP");

    if (idPays != null) {
      const pays = await prisma.pays.findUnique({ where: { idPays } });
      if (!pays) return fail("Pays introuvable", 404, "PAYS_NOT_FOUND");
    }

    const passwordHash = await hashPassword(password);

    // F4 : on écrit directement dans users (plus de table profiles)
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        pseudo,
        nom: nom ?? null,
        idPays: idPays ?? null,
        typeCompte: 0,
      },
    });

    const tokens = await issueTokenPair(user.id);
    return ok(
      {
        user: {
          id: user.id,
          email: user.email,
          publicNumber: user.publicNumber,
          pseudo,
          nom: nom ?? null,
          idPays: idPays ?? null,
          typeCompte: 0,
        },
        ...tokens,
      },
      201,
    );
  } catch (err) {
    return handleError(err);
  }
}
