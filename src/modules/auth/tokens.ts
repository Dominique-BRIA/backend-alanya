import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "@/lib/jwt";
import { RAISON_EVICTION } from "@/lib/sessions";

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
    data: { revoked: true },
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
  if (!stored) throw new Error("Refresh token inconnu");
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
    throw new Error("Refresh token révoqué");
  }
  if (stored.expiresAt < new Date()) throw new Error("Refresh token expiré");

  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revoked: true } });
  // Le lien avec l'appareil doit survivre à la rotation : sans ce report, il
  // serait perdu au premier rafraîchissement — donc au bout de 15 minutes — et
  // la session redeviendrait irrévocable.
  return issueTokenPair(payload.sub, stored.deviceId);
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  await prisma.refreshToken
    .updateMany({ where: { tokenHash: sha256(refreshToken) }, data: { revoked: true } })
    .catch(() => undefined);
}
