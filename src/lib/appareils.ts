import type { Appareil } from "@prisma/client";

/// Forme JSON d'un appareil exposée par l'API.
///
/// Les noms suivent le reste de l'API (camelCase), et non les noms physiques du
/// référentiel (`cookies_WebID`, `is_online`, `create_at`) : ceux-ci ne
/// concernent que la base. Le contrat HTTP reste ainsi homogène avec
/// `publicNumber`, `avatarUrl` et les autres.
export type AppareilJson = {
  appareilId: number;
  cookiesWebId: string | null;
  libelle: string;
  isOnline: boolean;
  typeDevice: number;
  system: string | null;
  nomAgent: string | null;
  createAt: string;
  lastLogin: string | null;
  /// `true` si l'appareil a été déconnecté à distance. La ligne est conservée
  /// pour l'historique, d'où un drapeau plutôt qu'une suppression.
  revoked: boolean;
  /// `true` si c'est le téléphone LIÉ au compte (`users.device_ID`). Le déconnecter
  /// depuis « Appareils connectés » le dissocie : le client doit le dire dans
  /// son libellé, sans quoi le geste ferait plus que ce qu'il annonce.
  lie: boolean;
};

/**
 * @param telephoneLie `users.device_ID` du compte. Seule la liste le fournit ;
 *   ailleurs l'appareil renvoyé vient d'être modifié et `lie` reste faux —
 *   aucun client ne le lit dans ces réponses.
 */
export function serializeAppareil(
  a: Appareil,
  telephoneLie: string | null = null,
): AppareilJson {
  return {
    appareilId: a.appareilId,
    cookiesWebId: a.cookiesWebId,
    libelle: a.libelle,
    // La base stocke des SMALLINT 0/1 (référentiel MySQL) ; l'API expose des
    // booléens, plus sûrs à consommer côté client.
    isOnline: a.isOnline === 1,
    typeDevice: a.typeDevice,
    system: a.system,
    /**
     * Pseudo donné à cet appareil pour ce compte.
     *
     * Il n'apparaît que dans la liste des appareils et au-dessus des messages
     * du compte : ce n'est pas un nom d'affichage, et il ne sort jamais vers un
     * autre compte. Ici la route est déjà filtrée sur `alanyaId = moi`, donc on
     * ne sert que ses propres appareils.
     */
    nomAgent: a.agent,
    createAt: a.createAt.toISOString(),
    lastLogin: a.lastLogin ? a.lastLogin.toISOString() : null,
    revoked: a.destroy === 1,
    lie: a.cookiesWebId !== null && a.cookiesWebId === telephoneLie,
  };
}
