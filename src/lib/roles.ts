import { prisma } from "./prisma";
import { fail } from "./http";

// Rôles applicatifs basés sur la colonne User.typeCompte (type_compte) :
//   0 = utilisateur normal (défaut)
//   9 = administrateur (modération : exclusion de comptes, etc.)
//
// La promotion d'un compte en admin se fait volontairement HORS application
// (mise à jour directe en base par un opérateur), tant qu'il n'existe pas de
// back-office dédié — évite qu'une faille applicative n'accorde ce pouvoir.
export const TYPE_COMPTE_ADMIN = 9;

export function isAdminTypeCompte(typeCompte: number | null | undefined): boolean {
  return typeCompte === TYPE_COMPTE_ADMIN;
}

/// Vérifie que l'appelant (`userId`) est administrateur.
/// Retourne `null` si OK, sinon une `Response` 403 prête à être renvoyée.
export async function ensureAdmin(userId: string): Promise<Response | null> {
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { typeCompte: true },
  });
  if (!me || !isAdminTypeCompte(me.typeCompte)) {
    return fail("Action réservée aux administrateurs", 403, "FORBIDDEN");
  }
  return null;
}
