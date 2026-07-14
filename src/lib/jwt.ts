import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "./env";

export type TokenScope = "access" | "refresh" | "setup";

export interface TokenPayload {
  sub: string; // userId
  scope: TokenScope;
}

function sign(payload: TokenPayload, secret: string, expiresIn: string): string {
  return jwt.sign(payload, secret, { expiresIn } as SignOptions);
}

export function signAccessToken(userId: string): string {
  return sign({ sub: userId, scope: "access" }, env.jwt.accessSecret(), env.jwt.accessTtl);
}

export function signRefreshToken(userId: string): string {
  return sign({ sub: userId, scope: "refresh" }, env.jwt.refreshSecret(), env.jwt.refreshTtl);
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
