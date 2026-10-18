import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { ALANYA_ID_REGEX, loginSchema } from "@/lib/validation";
import { estUnTelephone } from "@/lib/telephone-lie";
import { verifyPassword } from "@/lib/password";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { DUREE_DEFI_MS, deuxEtapesExigee, lancerDefi } from "@/lib/deux-etapes";
import { terminerConnexion } from "@/modules/auth/terminer-connexion";

// POST /api/auth/login
// Connexion par email OU par numéro public (6 ou 8 chiffres) + mot de passe.
export async function POST(req: NextRequest) {
  try {
    const rl = await rateLimit(`login:${clientIp(req)}`, 5, 60_000);
    if (!rl.allowed) return fail("Trop de tentatives, réessayez plus tard", 429, "RATE_LIMITED");

    const { identifier, password, deviceId, typeDevice } = loginSchema.parse(
      await req.json(),
    );

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

    /*
     * 🔴 CONNEXION WEB EN DEUX ÉTAPES (18/10/2026) — voir `src/lib/deux-etapes.ts`.
     *
     * Le mot de passe est bon, mais pour un navigateur dont le compte l'exige,
     * AUCUNE SESSION n'est délivrée ici : un code part dans l'application, et
     * c'est `POST /api/auth/login/code` qui finira la connexion.
     *
     * ⚠️ RIEN D'AUTRE NE BOUGE AVANT LE CODE : ni présence, ni journal, ni
     * éviction des autres sessions. Un mot de passe volé ne doit même pas
     * pouvoir déconnecter le vrai titulaire de son navigateur.
     */
    if (!estUnTelephone(deviceId, typeDevice) && deuxEtapesExigee(user)) {
      const defi = await lancerDefi(user.id, req);
      if (!defi.ok) {
        return fail(
          "La connexion web de ce compte demande un code envoyé dans l'application Alanya. Installez-la sur votre téléphone et connectez-vous-y d'abord.",
          409,
          "DEUX_ETAPES_SANS_APPLICATION",
        );
      }
      return ok({
        deuxEtapes: true,
        defiId: defi.defiId,
        expireDans: DUREE_DEFI_MS / 1000,
      });
    }

    return terminerConnexion(user, req, deviceId, typeDevice);
  } catch (err) {
    return handleError(err);
  }
}
