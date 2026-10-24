import { after, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { envoyerBienvenue } from "@/lib/gestion/bienvenue";
import { livrerStatutBienvenue } from "@/lib/gestion/statut-bienvenue";
import { invaliderProfil } from "@/lib/cache-redis.mjs";
import { ok, fail, handleError, estViolationUnicite } from "@/lib/http";
import { setupSchema } from "@/lib/validation";
import { nomAffichage } from "@/lib/display-name.mjs";
import { hashPassword } from "@/lib/password";
import { verifyAccessToken } from "@/lib/jwt";
import { issueTokenPair } from "@/modules/auth/tokens";
import { recordAccess } from "@/lib/user-access";
import { memoriserLangue } from "@/lib/langue-compte";
import { normaliserTelephone } from "@/lib/telephone.mjs";
import { estUnTelephone, lieOuVerifie } from "@/lib/telephone-lie";

const MOBILE_PRIS = "Ce numéro est déjà utilisé par un autre compte";

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

    /*
     * Le pays doit EXISTER dans la table de référence — ce contrôle était déjà
     * là et il est bon. Ce qui manquait, c'est que les clients envoient le BON
     * identifiant : chacun portait sa propre liste codée en dur, et le mobile
     * disait « 1 = Cameroun » quand la table dit « 1 = Afrique du Sud ». Le
     * contrôle passait donc sans rien détecter — l'identifiant existait, il
     * désignait simplement un autre pays. Les deux clients lisent désormais
     * `GET /api/pays`, devenue publique pour cette raison.
     */
    let prefixePays = "";
    if (idPays != null) {
      const pays = await prisma.pays.findUnique({ where: { idPays } });
      if (!pays) return fail("Pays introuvable", 404, "PAYS_NOT_FOUND");
      prefixePays = pays.prefix;
    }

    /*
     * 🔴 LE NUMÉRO EST NORMALISÉ ICI, ET C'EST LE SERVEUR QUI FAIT FOI.
     *
     * `users.mobile` est UNIQUE. Deux formes du même numéro — « 657308298 » et
     * « +237657308299 », les deux constatées en production le 25/08/2026 — ne
     * se ressemblent pas pour PostgreSQL : la même personne peut s'inscrire
     * deux fois, et la recherche par numéro n'en trouve qu'une.
     *
     * Les clients formatent aussi, pour l'affichage ; mais laisser la forme
     * stockée dépendre d'eux reviendrait à avoir autant de conventions que de
     * clients. La règle vit dans `src/lib/telephone.mjs`, seul endroit que les
     * trois traversent.
     */
    const mobileNormalise = mobile ? normaliserTelephone(mobile, prefixePays) : null;

    /*
     * ⚠️ LE NUMÉRO EST UNIQUE, LE NOM NON. Sans ce contrôle, un numéro déjà
     * porté par un autre compte faisait échouer l'écriture sur la contrainte,
     * et l'utilisateur lisait le message brut de Prisma (« Unique constraint
     * failed on the fields: (`mobile`) », capture du 24/10/2026). Même réponse
     * que `POST /api/account/mobile`.
     */
    if (mobileNormalise) {
      const prise = await prisma.user.findFirst({
        where: { mobile: mobileNormalise, NOT: { id: user.id } },
        select: { id: true },
      });
      if (prise) return fail(MOBILE_PRIS, 409, "MOBILE_TAKEN");
    }

    const passwordHash = await hashPassword(password);

    // F4 : on écrit directement dans users (plus de table profiles)
    try {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          pseudo,
          nom: nom ?? null,
          mobile: mobileNormalise,
          idPays: idPays ?? null,
          typeCompte: 0,
        },
      });
    } catch (err) {
      // Deux inscriptions simultanées avec le même numéro : le contrôle
      // ci-dessus est passé pour les deux, la contrainte départage.
      if (estViolationUnicite(err)) return fail(MOBILE_PRIS, 409, "MOBILE_TAKEN");
      throw err;
    }

    // Le compte existait déjà (créé à la vérification) : son profil a pu être
    // lu, donc mis en cache, avant que ce nom-ci ne soit posé.
    await invaliderProfil(user.id);

    // Premiere connexion du compte : elle merite sa ligne au journal.
    await recordAccess(prisma, { userId: user.id, req });
    // La langue de l'application : la bienvenue, envoyée juste après, la lit.
    await memoriserLangue(user.id, req);

    /*
     * L'inscription ouvre une session sans passer par `login` : elle doit donc
     * lier le téléphone elle aussi, sans quoi un compte créé sur mobile
     * resterait libre et un second téléphone pourrait s'y connecter.
     *
     * Le compte vient de naître, il est libre : la liaison ne peut pas échouer
     * ici. Le résultat est ignoré à dessein — refuser l'inscription après avoir
     * posé le mot de passe laisserait un compte à moitié créé.
     */
    if (deviceId && estUnTelephone(deviceId)) {
      await lieOuVerifie(user.id, deviceId);
    }

    const tokens = await issueTokenPair(user.id, deviceId);

    // Le compte est prêt : la bienvenue d'« Alanya Work » part juste après la
    // réponse (console de gestion). Sans version publiée, il ne se passe rien ;
    // un échec ne remonte jamais jusqu'à l'inscription.
    after(() => envoyerBienvenue(user.id).then(() => undefined));
    // Le statut de bienvenue, à la première inscription seulement (pas au
    // rattrapage), comme chez Alanya2026.
    after(() => livrerStatutBienvenue(user.id).then(() => undefined));

    return ok(
      {
        user: {
          id: user.id,
          email: user.email,
          publicNumber: user.publicNumber,
          // Le client affiche ce champ comme nom — voir `nomAffichage`.
          pseudo: nomAffichage({ nom, pseudo, publicNumber: user.publicNumber }),
          nom: nom ?? null,
          mobile: mobileNormalise,
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
