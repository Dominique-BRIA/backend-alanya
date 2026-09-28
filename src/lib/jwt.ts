import { randomUUID } from "crypto";
import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "./env";

export type TokenScope = "access" | "refresh" | "setup";

export interface TokenPayload {
  sub: string; // userId
  scope: TokenScope;
}

function sign(
  payload: TokenPayload,
  secret: string,
  expiresIn: string,
  options: SignOptions = {},
): string {
  return jwt.sign(payload, secret, { expiresIn, ...options } as SignOptions);
}

export function signAccessToken(userId: string): string {
  return sign({ sub: userId, scope: "access" }, env.jwt.accessSecret(), env.jwt.accessTtl);
}

/**
 * 🔴 CHAQUE JETON DE RAFRAÎCHISSEMENT EST UNIQUE, PAR SON `jti` ALÉATOIRE.
 *
 * Sans lui, le jeton ne portait que le compte et l'heure À LA SECONDE : deux
 * sessions du même compte ouvertes dans la même seconde — un téléphone et un
 * navigateur, un double appui sur « Se connecter » — recevaient le MÊME jeton,
 * donc le même hachage en base. Le serveur retrouvait alors l'une ou l'autre
 * ligne au hasard : un téléphone dissocié, dont la session était révoquée,
 * continuait de se rafraîchir sous celle du navigateur. Relevé le 28/09/2026
 * par `scripts/telephone-lie-banc.mjs`.
 *
 * Le jeton d'accès n'en a pas besoin : il n'est pas enregistré, deux copies
 * identiques ne se confondent avec rien.
 */
export function signRefreshToken(userId: string): string {
  return sign({ sub: userId, scope: "refresh" }, env.jwt.refreshSecret(), env.jwt.refreshTtl, {
    jwtid: randomUUID(),
  });
}

// Token court (15 min) autorisant uniquement l'étape « setup » (choix pseudo + mot de passe).
export function signSetupToken(userId: string): string {
  return sign({ sub: userId, scope: "setup" }, env.jwt.accessSecret(), "15m");
}

export function verifyAccessToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, env.jwt.accessSecret()) as TokenPayload;
  return decoded;
}

export function verifyRefreshToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, env.jwt.refreshSecret()) as TokenPayload;
  return decoded;
}
