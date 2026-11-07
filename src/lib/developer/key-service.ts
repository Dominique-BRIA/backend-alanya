import crypto from "crypto";
import { prisma } from "@/lib/prisma";

export interface GeneratedKeyResult {
  rawKey: string;
  keyHash: string;
  /** Les 12 premiers caractères, pour reconnaître la clé sans la révéler. */
  prefix: string;
}

/** Longueur du début de clé gardé en clair — le même que dans le journal. */
export const LONGUEUR_PREFIXE = 12;

/**
 * Génère une clé API. La clé brute (`ak_live_…`) n'est montrée QU'UNE FOIS ;
 * seule son empreinte SHA-256 est stockée.
 *
 * 🔴 PLUS DE `ak_test_` (07/11/2026) : la distinction Sandbox / Production ne
 * changeait aucun comportement, toutes les clés produisaient des effets réels.
 */
export function generateApiKey(): GeneratedKeyResult {
  const rawKey = `ak_live_${crypto.randomBytes(24).toString("hex")}`;
  return {
    rawKey,
    keyHash: hashApiKey(rawKey),
    prefix: rawKey.slice(0, LONGUEUR_PREFIXE),
  };
}

/** Empreinte SHA-256 d'une clé brute. */
export function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey.trim()).digest("hex");
}

/**
 * Valide une clé transmise dans `X-Api-Key` ou `Authorization: Bearer ak_…`.
 *
 * Rend la clé avec son enseigne si tout est en règle : clé active, compte de
 * l'enseigne et compte de sa propriétaire non suspendus. Une personne
 * suspendue ne doit pas pouvoir continuer d'écrire par ses enseignes.
 */
export async function validateApiKey(rawKey: string) {
  if (!rawKey || !rawKey.startsWith("ak_")) return null;

  try {
    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(rawKey) },
      select: {
        id: true,
        isActive: true,
        developer: {
          select: {
            id: true,
            userId: true,
            user: { select: { exclus: true } },
            proprietaire: { select: { exclus: true } },
          },
        },
      },
    });

    if (!apiKey || !apiKey.isActive) return null;
    if (apiKey.developer.user.exclus === 1 || apiKey.developer.proprietaire.exclus === 1) return null;

    // Date de dernière utilisation, sans attendre ni faire échouer l'appel.
    prisma.apiKey
      .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    return apiKey;
  } catch (error) {
    console.error("[KeyService] Erreur lors de la validation de clé API:", error);
    return null;
  }
}
