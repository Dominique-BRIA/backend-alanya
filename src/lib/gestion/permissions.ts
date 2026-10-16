/**
 * Les permissions de la console de gestion (alanyavox.com/gestion).
 *
 * Les NOMS sont ceux de la console d'origine (Chris-Manuelpipo/Alanya-admin,
 * `src/constants/adminRoles.js` de son backend) : la console masque ses menus
 * et ses boutons d'après la liste que renvoie `GET /api/admin/me`. Un nom
 * changé ici, et l'écran correspondant disparaît sans erreur.
 *
 * ⚠️ AUCUN NIVEAU INTERMÉDIAIRE, PAR DÉCISION DU 15/10/2026. Seul le superroot
 * d'alanyaCenter se connecte, et il a tout. La seule restriction est celle
 * qu'alanyaCenter applique déjà : un compte `Root` de type 0 est en lecture
 * seule (voir `session.ts`). La liste existe quand même, et chaque route
 * déclare la sienne : le jour où un rôle limité arrive, il suffira de changer
 * `permissionsDe()`, pas de relire toutes les routes.
 */
export const TOUTES_LES_PERMISSIONS = [
  "ai.editorial",
  "analytics.export",
  "audit.read",
  "backup.keys",
  "billing.codes",
  "billing.gift",
  "billing.plans",
  "billing.read",
  "billing.settings",
  "broadcasts.cancel",
  "broadcasts.read",
  "broadcasts.send",
  "groups.delete",
  "groups.read",
  "media.delete",
  "media.read",
  "meetings.delete",
  "meetings.end",
  "meetings.read",
  "official.create",
  "official.read",
  "phones.read",
  "phones.release",
  "phones.reserve",
  "profile.password",
  "profile.read",
  "profile.update",
  "purges.read",
  "purges.run",
  "purges.settings",
  "reports.handle",
  "reports.read",
  "settings.read",
  "settings.write",
  "stats.read",
  "stickers.moderate",
  "stickers.publish",
  "stickers.read",
  "stickers.settings",
  "stickers.write",
  "trips.purge",
  "trips.read",
  "users.ban",
  "users.create",
  "users.delete",
  "users.export",
  "users.phone",
  "users.read",
  "users.role",
  "users.socle",
  "users.unban",
  "verifications.decide",
  "verifications.read",
  "villes.read",
  "welcome.backfill",
  "welcome.draft",
  "welcome.publish",
  "welcome.read",
  "welcome.status",
] as const;

export type Permission = (typeof TOUTES_LES_PERMISSIONS)[number];

/**
 * Ce qu'un compte en lecture seule peut quand même faire en écriture : changer
 * son propre mot de passe. alanyaCenter fait la même exception
 * (`checkReadOnlyRoot`, « la mise à jour de son propre profil reste permise »).
 */
export const PERMISES_EN_LECTURE_SEULE: ReadonlySet<Permission> = new Set(["profile.password"]);

/**
 * Ce que la console d'origine savait faire et que NOUS ne faisons pas : la
 * facturation grand public (exclue le 15/10/2026), les clés de sauvegarde de
 * son chiffrement (le nôtre est différent), le « rôle » et le « socle » d'un
 * compte (chez nous, le type de compte appartient à alanyaCenter). Ne pas les
 * déclarer suffit à faire disparaître les boutons de la console.
 */
const NON_PRISES_EN_CHARGE: ReadonlySet<Permission> = new Set([
  "billing.codes",
  "billing.gift",
  "billing.plans",
  "billing.read",
  "billing.settings",
  "backup.keys",
  "users.role",
  "users.socle",
  // Le profil d'un superroot (nom, e-mail) n'existe pas dans la table Root.
  "profile.update",
  // Ni mode maintenance, ni interrupteur de liaison au téléphone chez nous.
  "settings.write",
]);

/** Les permissions d'une session : toutes celles qui ont un sens chez nous. */
export function permissionsDe(): Permission[] {
  return TOUTES_LES_PERMISSIONS.filter((p) => !NON_PRISES_EN_CHARGE.has(p));
}
