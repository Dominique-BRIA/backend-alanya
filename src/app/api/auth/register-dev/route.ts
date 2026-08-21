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

    /*
     * 🔴 `typeCompte` N'EST PLUS TOUCHÉ ICI (18/08/2026).
     *
     * Cette route posait `typeCompte = 4` pour marquer un compte développeur.
     * Or 4 désigne un CENTRE VOCAL dans le référentiel de l'équipe
     * (`TYPE_COMPTE_CENTRE_VOCAL` de `src/lib/ivr.mjs`, compte `303030` en
     * production). Les deux sens ne peuvent pas coexister : depuis le lot A,
     * `handleCallRing` ouvre un standard vocal devant tout compte à 4, si bien
     * qu'une inscription développeur aurait rendu son auteur INJOIGNABLE —
     * quiconque l'appelle tomberait sur un menu au lieu de le faire sonner.
     *
     * Rien n'est perdu : le statut développeur est porté par les tables
     * `developer_accounts` et `developer_api_keys`, et c'est déjà sur elles que
     * repose TOUT le contrôle d'accès des routes `/api/developer/*` et
     * `/api/v1/*` — aucune ne lit `typeCompte`. La ligne était donc décorative.
     * Vérifié en production avant de la retirer : les 3 comptes développeurs
     * existants sont en `type_compte` 0, 0 et 2, aucun n'était à 4. Aucune
     * donnée à migrer.
     *
     * Le compte garde ainsi son type d'origine — un développeur reste un
     * utilisateur ordinaire, joignable comme tel, qui a en plus une clé d'API.
     */
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        pseudo: nom.trim(),
        nom: nom.trim(),
        mobile: mobile ? mobile.trim() : null,
        idPays: idPays ? Number(idPays) : null,
        avatarUrl: finalAvatar,
      },
    });

    /*
     * Création du compte `developer_accounts` — il porte l'accès à l'API, plus
     * aucun solde. Les « 1 000 crédits offerts » et leur ligne de registre ont
     * disparu avec la facturation (21/08/2026) : l'API n'est pas vendue, elle
     * sert la plateforme de l'équipe, qui gère son propre paiement.
     *
     * ⚠️ Les colonnes `balance_credits` / `hold_credits` RESTENT en base, avec
     * leur valeur par défaut — elles sont partagées avec le second système qui
     * écrit dans cette base, et personne n'a demandé de les retirer. Elles ne
     * sont simplement plus ni lues ni écrites par nous.
     */
    const devAccount =
      (await prisma.developerAccount.findUnique({ where: { userId: user.id } })) ??
      (await prisma.developerAccount.create({ data: { userId: user.id } }));

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
      },
      tokens,
    });
  } catch (err) {
    return handleError(err);
  }
}
