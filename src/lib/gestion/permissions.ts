/**
 * Les rôles et les permissions de la console de gestion (alanyavox.com/gestion).
 *
 * 🔁 DEPUIS LE 24/10/2026, À L'IDENTIQUE D'ALANYA2026 (`Alanya2026/Alanya-backend`,
 * `src/constants/adminRoles.js`) : un compte Alanya promu « Admin » ou
 * « Super Admin » se connecte à la console, et chaque rôle a SA liste de
 * permissions — les mêmes noms, la même frontière entre les deux rôles.
 *
 * Une seule différence, voulue (décision du user du 24/10) : le rôle n'est pas
 * dans `users.type_compte`, qui dit chez nous ce qu'EST le compte (agent,
 * centre d'appels, compte officiel…) et que lit alanyaCenter, mais dans sa
 * propre colonne, `users.role_admin`.
 *
 * Les NOMS comptent : la console masque ses menus et ses boutons d'après la
 * liste que renvoie `GET /api/admin/me`. Un nom changé ici, et l'écran
 * correspondant disparaît sans erreur.
 */

/** Ce qu'un administrateur peut faire (leur `ADMIN_PERMISSIONS`). */
const PERMISSIONS_ADMIN = [
  // Lecture et diagnostic
  "stats.read",
  "users.read",
  "groups.read",
  "media.read",
  "meetings.read",
  "broadcasts.read",
  "trips.read",
  "purges.read",
  "settings.read",
  "phones.read",
  "official.read",
  "villes.read",
  "audit.read",
  // Modération
  "reports.read",
  "reports.handle",
  // Exports
  "users.export",
  "analytics.export",
  // Son propre compte
  "profile.read",
  "profile.update",
  "profile.password",
  // Contenus
  "media.delete",
  "meetings.end",
  "meetings.delete",
  "groups.delete",
  // Comptes, sans les actions irréversibles
  "users.create",
  "users.phone",
  // Diffusions
  "broadcasts.send",
  "broadcasts.cancel",
  // Assistance éditoriale
  "ai.editorial",
  // Dossiers d'identité
  "verifications.read",
  "verifications.decide",
  // Stickers
  "stickers.read",
  "stickers.write",
  "stickers.moderate",
] as const;

/** Ce que le super-admin est seul à pouvoir faire (leur `SUPER_ADMIN_ONLY`). */
const PERMISSIONS_SUPER_ADMIN_SEUL = [
  "users.ban",
  "users.unban",
  "users.role",
  "users.socle",
  "users.delete",
  "purges.run",
  "purges.settings",
  "trips.purge",
  "settings.write",
  "phones.reserve",
  "phones.release",
  "official.create",
  "welcome.read",
  "welcome.draft",
  "welcome.publish",
  "welcome.backfill",
  "welcome.status",
  "stickers.publish",
  "stickers.settings",
] as const;

/*
 * Absentes, et c'est voulu : la facturation (`billing.*`, exclue par le user
 * le 15/10 puis le 24/10/2026), le coffre-fort et les clés de sauvegarde de
 * leur chiffrement (`safebox.*`, `backup.keys` : le nôtre est différent). Ne
 * pas les déclarer suffit à faire disparaître les écrans de la console.
 */

export const TOUTES_LES_PERMISSIONS = [...PERMISSIONS_ADMIN, ...PERMISSIONS_SUPER_ADMIN_SEUL] as const;

export type Permission = (typeof TOUTES_LES_PERMISSIONS)[number];

export const ROLE_UTILISATEUR = 0;
export const ROLE_ADMIN = 1;
export const ROLE_SUPER_ADMIN = 2;

const PERMISSIONS_PAR_ROLE: Record<number, ReadonlySet<Permission>> = {
  [ROLE_ADMIN]: new Set(PERMISSIONS_ADMIN),
  [ROLE_SUPER_ADMIN]: new Set(TOUTES_LES_PERMISSIONS),
};

/** Le rôle donne-t-il cette permission ? Un simple utilisateur n'en a aucune. */
export function peut(role: number, permission: Permission): boolean {
  return PERMISSIONS_PAR_ROLE[role]?.has(permission) ?? false;
}

/** Les permissions d'un rôle, triées : c'est ce que la console lit. */
export function permissionsDe(role: number): Permission[] {
  return [...(PERMISSIONS_PAR_ROLE[role] ?? [])].sort();
}
