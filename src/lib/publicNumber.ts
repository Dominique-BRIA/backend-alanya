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

/**
 * Comptes designes par leurs numeros Alanya, indexes par le numero.
 *
 * SOURCE UNIQUE de la resolution « numero -> compte ». POST /api/contacts et les
 * listes de contacts passent tous par ici, et c'est le point : deux resolutions
 * ecrites separement finiraient par ne plus accepter les memes saisies, et un
 * numero ajoutable au repertoire serait refuse dans une liste — ou l'inverse.
 * La forme acceptee du numero, elle, est tenue une seule fois aussi, par
 * `publicNumberSchema` (src/lib/validation.ts).
 *
 * La cle rendue est le numero tel que la BASE le porte, pas celui envoye par le
 * client : la colonne est unique, les deux coincident, mais c'est la base qui
 * fait foi partout ailleurs et il n'y a pas de raison de faire autrement ici.
 *
 * Aucun filtre sur `actif`, `exclus` ou `isDelete` : POST /api/contacts n'en
 * pose pas, et en ajouter un ici ferait diverger les deux comportements. Rien ne
 * dit aujourd'hui laquelle de ces trois colonnes fait foi (voir [User]) ; c'est
 * une question a trancher pour toute l'API, pas dans un coin.
 */
export async function comptesParNumerosPublics(
  numeros: string[],
): Promise<Map<string, string>> {
  const demandes = [...new Set(numeros)];
  if (demandes.length === 0) return new Map();

  const comptes = await prisma.user.findMany({
    where: { publicNumber: { in: demandes } },
    select: { id: true, publicNumber: true },
  });

  return new Map(comptes.map((u) => [u.publicNumber, u.id] as const));
}
