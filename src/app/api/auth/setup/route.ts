import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { setupSchema } from "@/lib/validation";
import { nomAffichage } from "@/lib/display-name.mjs";
import { hashPassword } from "@/lib/password";
import { verifyAccessToken } from "@/lib/jwt";
import { issueTokenPair } from "@/modules/auth/tokens";
import { recordAccess } from "@/lib/user-access";

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

    const { pseudo, password, nom, mobile, idPays, deviceId } =
      setupSchema.parse(await req.json());

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return fail("Compte non vérifié", 400, "NOT_VERIFIED");
    /*
     * ⚠️ LE CONTRÔLE PORTE SUR L'ADRESSE, PLUS SUR LE SEUL DRAPEAU.
     *
     * Il lisait `!user.emailVerified`. Depuis que l'adresse est facultative
     * (25/08/2026), un compte ouvert sans adresse a `emailVerified = false`
     * pour de bon — il n'y a rien à vérifier — et cette garde l'aurait bloqué
     * juste avant le choix de son mot de passe, avec « Compte non vérifié »
     * pour toute explication.
     *
     * La règle réelle n'a pas changé : une adresse déclarée doit avoir été
     * confirmée. Sans adresse, il n'y a pas d'affirmation à prouver, et c'est
     * le `setupToken` — signé par nous, à l'instant, pour ce compte — qui fait
     * seul autorité.
     */
    if (user.email !== null && !user.emailVerified) {
      return fail("Compte non vérifié", 400, "NOT_VERIFIED");
    }
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
        mobile: mobile ?? null,
        idPays: idPays ?? null,
        typeCompte: 0,
      },
    });

    // Premiere connexion du compte : elle merite sa ligne au journal.
    await recordAccess(prisma, { userId: user.id, req });

    const tokens = await issueTokenPair(user.id, deviceId);
    return ok(
      {
        user: {
          id: user.id,
          email: user.email,
          publicNumber: user.publicNumber,
          // Le client affiche ce champ comme nom — voir `nomAffichage`.
          pseudo: nomAffichage({ nom, pseudo, publicNumber: user.publicNumber }),
          nom: nom ?? null,
          mobile: mobile ?? null,
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
