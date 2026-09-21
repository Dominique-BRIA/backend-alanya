import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "@/lib/jwt";
import { RAISON_EVICTION, RAISON_REJEU, RAISON_REVOCATION } from "@/lib/sessions";

/**
 * La session a été fermée par l'ouverture d'une autre, sur un appareil de la
 * même famille. Distincte d'un jeton simplement expiré ou déjà tourné : elle
 * seule justifie de dire à l'utilisateur que son compte a été ouvert ailleurs.
 */
export class SessionEvinceeError extends Error {
  constructor() {
    super("Session fermée depuis un autre appareil");
    this.name = "SessionEvinceeError";
  }
}

/**
 * Le jeton présenté a déjà tourné, ET son successeur aussi : deux porteurs se
 * servent du même jeton. Toute la chaîne a été coupée.
 *
 * ⚠️ DISTINCTE DU SIMPLE REJEU, qui n'est pas une faute. Voir la fenêtre de
 * grâce dans [rotateRefreshToken] : un client qui réessaie après une réponse
 * perdue rejoue le même jeton quelques secondes plus tard, et cela doit
 * réussir. Seul un rejeu TARDIF — après que le successeur a lui-même servi —
 * accuse une copie en circulation.
 */
export class JetonRejoueError extends Error {
  constructor() {
    super("Jeton de rafraîchissement rejoué");
    this.name = "JetonRejoueError";
  }
}

/**
 * Combien de temps un jeton déjà tourné reste rejouable.
 *
 * 🔴 CE DÉLAI EST LA CORRECTION DU DÉFAUT « déconnecté alors que rien n'avait
 * expiré ». Il couvre les trois façons dont un client honnête rejoue :
 *
 *   * la réponse du rafraîchissement s'est perdue — le serveur a tourné le
 *     jeton, le client ne l'a jamais su et réessaie avec l'ancien ;
 *   * l'application est tuée entre la rotation et l'écriture du nouveau jeton
 *     dans le stockage sécurisé — au redémarrage elle ne connaît que l'ancien ;
 *   * deux chemins se rafraîchissent en même temps — l'isolat d'arrière-plan
 *     des notifications ne partage pas le verrou de l'isolat principal.
 *
 * ⚠️ TRENTE SECONDES, ET NON CINQ MINUTES. La fenêtre est un affaiblissement
 * assumé : pendant ce temps, un jeton volé reste utilisable. Elle doit couvrir
 * un aller-retour réseau et un redémarrage d'application, pas davantage.
 */
export const FENETRE_REJEU_MS = 30_000;

/**
 * L'utilisateur a lui-même fermé cette session depuis « Appareils connectés ».
 *
 * 🔴 SANS CETTE CLASSE, LA DÉCONNEXION À DISTANCE NE MARCHAIT PLUS. Depuis que
 * le client ne se déconnecte que sur un verdict NOMMÉ, un refus anonyme
 * (`BAD_REFRESH`) le fait simplement réessayer : l'appareil qu'on venait de
 * révoquer serait resté connecté en tournant en rond.
 */
export class SessionRevoqueeError extends Error {
  constructor() {
    super("Session révoquée depuis « Appareils connectés »");
    this.name = "SessionRevoqueeError";
  }
}

/**
 * Le jeton est inconnu, ou sa validité de sept jours est écoulée. Terminal :
 * aucun réessai ne le fera revivre.
 */
export class SessionExpireeError extends Error {
  constructor() {
    super("Session expirée");
    this.name = "SessionExpireeError";
  }
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const REFRESH_TTL_DAYS = 7;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

// Émet un couple access/refresh et persiste le refresh token (haché) en base.
/**
 * @param deviceId identifiant stable de l'appareil (`Appareil.cookies_WebID`).
 *   Facultatif : sans lui la session reste valide, mais ne pourra pas être
 *   révoquée individuellement depuis « Appareils connectés ».
 */
export async function issueTokenPair(
  userId: string,
  deviceId?: string | null,
): Promise<TokenPair> {
  const accessToken = signAccessToken(userId);
  const refreshToken = signRefreshToken(userId);

  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: { userId, tokenHash: sha256(refreshToken), expiresAt, deviceId: deviceId ?? null },
  });

  return { accessToken, refreshToken };
}

/**
 * Révoque toutes les sessions ouvertes depuis un appareil donné.
 *
 * L'effet n'est pas instantané : le jeton d'accès déjà délivré reste valide
 * jusqu'à son expiration (15 minutes par défaut), car c'est un JWT sans état,
 * invérifiable en base. Passé ce délai, le rafraîchissement échoue et
 * l'appareil se retrouve déconnecté. C'est le compromis habituel des jetons
 * courts ; le raccourcir reviendrait à interroger la base à chaque requête.
 *
 * @returns le nombre de sessions révoquées.
 */
export async function revokeDeviceSessions(
  userId: string,
  deviceId: string,
): Promise<number> {
  const { count } = await prisma.refreshToken.updateMany({
    where: { userId, deviceId, revoked: false },
    data: {
      revoked: true,
      /*
       * 🔴 LA RAISON EST OBLIGATOIRE DEPUIS QUE LE CLIENT N'OBÉIT QU'À UN
       * VERDICT NOMMÉ. Sans elle, cette révocation retombait sur le refus
       * anonyme `BAD_REFRESH` — que le client traite désormais comme un
       * réessai. L'appareil qu'on venait de déconnecter à distance serait
       * resté en place, à réessayer indéfiniment.
       */
      revokedReason: RAISON_REVOCATION,
    },
  });
  return count;
}

// Vérifie un refresh token (signature + présence en base + non révoqué + non expiré),
// puis effectue une rotation : l'ancien est révoqué et un nouveau couple est émis.
export async function rotateRefreshToken(refreshToken: string): Promise<TokenPair> {
  const payload = verifyRefreshToken(refreshToken);
  if (payload.scope !== "refresh") throw new Error("Token invalide");

  const stored = await prisma.refreshToken.findFirst({
    where: { userId: payload.sub, tokenHash: sha256(refreshToken) },
  });
  // Inconnu = terminal. Le client doit se reconnecter, pas réessayer.
  if (!stored) throw new SessionExpireeError();
  /*
   * ⚠️ « Révoqué » ne dit PAS pourquoi. La rotation révoque l'ancien jeton à
   * chaque rafraîchissement : c'est le cas le plus fréquent, et il n'a rien
   * d'anormal — un client qui réessaie après une réponse perdue tombe dessus.
   *
   * Seule une révocation posée par l'éviction mérite un message. Sans cette
   * distinction, un simple réessai afficherait « votre compte a été ouvert sur
   * un autre appareil » : alarmant, et faux.
   */
  if (stored.revoked) {
    if (stored.revokedReason === RAISON_EVICTION) throw new SessionEvinceeError();
    if (stored.revokedReason === RAISON_REVOCATION) throw new SessionRevoqueeError();
    if (stored.revokedReason === RAISON_REJEU) throw new JetonRejoueError();

    /*
     * ━━ LE REJEU : UN RÉESSAI, OU UN VOL ? ━━
     *
     * 🔴 C'EST ICI QUE LE SYSTÈME DÉCONNECTAIT DES GENS POUR RIEN. Tout jeton
     * déjà tourné était refusé, et le client détruisait sa session sur le 401
     * qui suivait. Or la rotation révoque l'ancien jeton à CHAQUE
     * rafraîchissement : n'importe quel réessai tombait dessus.
     *
     * On sépare désormais les deux cas, comme le prescrit la rotation avec
     * détection de rejeu (OAuth 2.1).
     */
    if (stored.rotatedAt) {
      const ageMs = Date.now() - stored.rotatedAt.getTime();

      /*
       * Rejeu TARDIF : le jeton a tourné il y a longtemps. Si son successeur a
       * lui-même déjà servi, deux porteurs se partagent la chaîne — l'un des
       * deux a une copie. On ne sait pas lequel est le bon, donc on coupe tout
       * et on redemande le mot de passe.
       *
       * ⚠️ ON NE COUPE QUE SI LE SUCCESSEUR A SERVI. Un rejeu tardif dont le
       * successeur n'a jamais été utilisé, c'est un appareil resté longtemps
       * hors ligne avec un jeton périmé dans les mains — pas une attaque. Le
       * refuser suffit.
       */
      if (ageMs > FENETRE_REJEU_MS) {
        if (await successeurDejaServi(stored.remplacePar)) {
          await revoqueLaChaine(payload.sub, stored.deviceId);
          throw new JetonRejoueError();
        }
        throw new Error("Refresh token révoqué");
      }

      /*
       * Rejeu IMMÉDIAT : réessai de bonne foi. On émet un couple neuf pour le
       * même appareil.
       *
       * ⚠️ ON N'INVALIDE PAS LE SUCCESSEUR, et ce n'est pas un oubli : si les
       * deux réponses finissent par arriver, le client garde la dernière et
       * l'autre mourra d'elle-même à l'expiration. Couper le successeur ici
       * déconnecterait précisément le client qu'on cherche à sauver.
       */
      return issueTokenPair(payload.sub, stored.deviceId);
    }

    throw new Error("Refresh token révoqué");
  }
  if (stored.expiresAt < new Date()) throw new SessionExpireeError();

  // Le lien avec l'appareil doit survivre à la rotation : sans ce report, il
  // serait perdu au premier rafraîchissement — donc au bout de 15 minutes — et
  // la session redeviendrait irrévocable.
  const suivant = await issueTokenPair(payload.sub, stored.deviceId);

  /*
   * ⚠️ LA RÉVOCATION VIENT APRÈS L'ÉMISSION, pour pouvoir inscrire le
   * successeur dans la même écriture. C'est `remplace_par` qui rend la chaîne
   * lisible, et sans elle le rejeu tardif ne serait pas distinguable du vol.
   */
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: {
      revoked: true,
      rotatedAt: new Date(),
      remplacePar: sha256(suivant.refreshToken),
    },
  });

  return suivant;
}

/** Le jeton issu d'une rotation a-t-il lui-même déjà servi ? */
async function successeurDejaServi(hashSuccesseur: string | null): Promise<boolean> {
  if (!hashSuccesseur) return false;
  const successeur = await prisma.refreshToken.findFirst({
    where: { tokenHash: hashSuccesseur },
    select: { rotatedAt: true },
  });
  return Boolean(successeur?.rotatedAt);
}

/**
 * Coupe toutes les sessions vivantes d'un appareil — la réponse à un jeton
 * manifestement copié.
 *
 * ⚠️ CIBLÉ SUR L'APPAREIL, PAS SUR LE COMPTE. Un jeton volé sur un téléphone ne
 * dit rien de l'ordinateur de la même personne : tout couper punirait deux fois
 * quelqu'un qui subit déjà l'incident. Sans `deviceId` — sessions anciennes —
 * on ne sait pas cibler, et on préfère ne rien couper de plus que le jeton
 * présenté, qui l'est déjà.
 */
async function revoqueLaChaine(userId: string, deviceId: string | null): Promise<void> {
  if (!deviceId) return;
  await prisma.refreshToken.updateMany({
    where: { userId, deviceId, revoked: false },
    data: { revoked: true, revokedReason: RAISON_REJEU },
  });
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  await prisma.refreshToken
    .updateMany({ where: { tokenHash: sha256(refreshToken) }, data: { revoked: true } })
    .catch(() => undefined);
}
