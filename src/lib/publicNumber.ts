import crypto from "crypto";
import { prisma } from "./prisma";

// Numéro public à 8 chiffres servant d'identifiant cherchable (différent de l'UUID interne).
// On évite les numéros commençant par 0 pour rester sur 8 vrais chiffres (10000000..99999999).
function randomEightDigits(): string {
  return crypto.randomInt(10_000_000, 100_000_000).toString();
}

// Génère un numéro public unique (réessaie en cas de collision improbable).
export async function generateUniquePublicNumber(maxAttempts = 12): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = randomEightDigits();
    const existing = await prisma.user.findUnique({
      where: { publicNumber: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  throw new Error("Impossible de générer un numéro public unique, réessayez.");
}
