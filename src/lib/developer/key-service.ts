import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { ApiKeyType } from '@prisma/client';

export interface GeneratedKeyResult {
  rawKey: string;
  keyHash: string;
  prefix: string;
}

/**
 * Génère une nouvelle clé API cryptographiquement sécurisée.
 * La clé brute (ex: `ak_live_...`) n'est affichée QU'UNE SEULE FOIS au développeur.
 * Seul le hash SHA-256 est stocké en base de données.
 */
export function generateApiKey(type: ApiKeyType = ApiKeyType.SANDBOX): GeneratedKeyResult {
  const prefix = type === ApiKeyType.SANDBOX ? 'ak_test_' : 'ak_live_';
  const randomBytes = crypto.randomBytes(24).toString('hex');
  const rawKey = `${prefix}${randomBytes}`;
  const keyHash = hashApiKey(rawKey);

  return {
    rawKey,
    keyHash,
    prefix: prefix.slice(0, -1), // "ak_test" ou "ak_live"
  };
}

/**
 * Calcule le hash SHA-256 d'une clé API brute.
 */
export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey.trim()).digest('hex');
}

/**
 * Valide une clé API transmise dans l'en-tête `X-Api-Key` ou `Authorization: Bearer ak_...`.
 * Renvoyé si valide, active et associée à un compte développeur actif.
 */
export async function validateApiKey(rawKey: string) {
  if (!rawKey || !rawKey.startsWith('ak_')) return null;

  const keyHash = hashApiKey(rawKey);

  try {
    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash },
      include: {
        developer: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                nom: true,
                pseudo: true,
                publicNumber: true,
              },
            },
          },
        },
      },
    });

    if (!apiKey || !apiKey.isActive) return null;

    // Met à jour la date de dernière utilisation sans bloquer
    prisma.apiKey
      .update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {});

    return apiKey;
  } catch (error) {
    console.error('[KeyService] Erreur lors de la validation de clé API:', error);
    return null;
  }
}
