import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "@/lib/jwt";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const REFRESH_TTL_DAYS = 7;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

// Émet un couple access/refresh et persiste le refresh token (haché) en base.
export async function issueTokenPair(userId: string): Promise<TokenPair> {
  const accessToken = signAccessToken(userId);
  const refreshToken = signRefreshToken(userId);

  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: { userId, tokenHash: sha256(refreshToken), expiresAt },
  });

  return { accessToken, refreshToken };
}

// Vérifie un refresh token (signature + présence en base + non révoqué + non expiré),
// puis effectue une rotation : l'ancien est révoqué et un nouveau couple est émis.
export async function rotateRefreshToken(refreshToken: string): Promise<TokenPair> {
  const payload = verifyRefreshToken(refreshToken);
  if (payload.scope !== "refresh") throw new Error("Token invalide");

  const stored = await prisma.refreshToken.findFirst({
    where: { userId: payload.sub, tokenHash: sha256(refreshToken) },
  });
  if (!stored || stored.revoked || stored.expiresAt < new Date()) {
    throw new Error("Refresh token invalide ou expiré");
  }

  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revoked: true } });
  return issueTokenPair(payload.sub);
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  await prisma.refreshToken
    .updateMany({ where: { tokenHash: sha256(refreshToken) }, data: { revoked: true } })
    .catch(() => undefined);
}
