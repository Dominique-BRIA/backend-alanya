/**
 * LES RÈGLES PURES du chiffrement des groupes v2 (11/11/2026) : sans base ni
 * réseau, pour être vérifiées seules (`scripts/e2ee-v2-regles-banc.ts`).
 * Utilisées par `e2ee-v2.ts`. Conception : `docs/2026-11-11-e2ee-groupes-v2-conception.md`.
 */

export type VersionDatee = { version: number; creeLe: Date };

/**
 * Les versions qu'un membre a le droit de recevoir (conception § 4).
 * Historique caché (`historiqueDepuis` posé à son arrivée) : seulement celles
 * créées à partir de son arrivée — la version tirée pour lui, et les
 * suivantes. Historique visible (`null`) : toutes.
 */
export function versionsDues(versions: VersionDatee[], historiqueDepuis: Date | null): number[] {
  return versions
    .filter((v) => !historiqueDepuis || v.creeLe.getTime() >= historiqueDepuis.getTime())
    .map((v) => v.version);
}

/** Les versions 1…cleVersion, datées par les lignes connues (epoch sinon). */
export function versionsCompletes(cleVersion: number, lignes: VersionDatee[]): VersionDatee[] {
  const dates = new Map(lignes.map((l) => [l.version, l.creeLe]));
  return Array.from({ length: cleVersion }, (_, i) => ({
    version: i + 1,
    creeLe: dates.get(i + 1) ?? new Date(0),
  }));
}

export type Manquant = { userId: string; versionCompte: number; publique: string; versions: number[] };

/** Ce qu'il reste à emballer, membre par membre (conception § 5.6). */
export function calculerManquants(
  versions: VersionDatee[],
  membres: { userId: string; historiqueDepuis: Date | null }[],
  cles: { userId: string; version: number; publique: string }[],
  existants: { userId: string; version: number; versionCompte: number }[],
): { manquants: Manquant[]; sansCle: string[] } {
  const cleDe = new Map(cles.map((c) => [c.userId, c]));
  const possede = new Set(existants.map((e) => `${e.userId}:${e.versionCompte}:${e.version}`));
  const manquants: Manquant[] = [];
  const sansCle: string[] = [];
  for (const m of membres) {
    const cle = cleDe.get(m.userId);
    if (!cle) {
      sansCle.push(m.userId);
      continue;
    }
    const manque = versionsDues(versions, m.historiqueDepuis).filter(
      (v) => !possede.has(`${m.userId}:${cle.version}:${v}`),
    );
    if (manque.length > 0) {
      manquants.push({ userId: m.userId, versionCompte: cle.version, publique: cle.publique, versions: manque });
    }
  }
  return { manquants, sansCle };
}

/**
 * Le motif de refus d'un dépôt d'emballage, ou `null` s'il est accepté
 * (conception § 9).
 */
export function motifRefusDepot(p: {
  deposant: string;
  destinataire: string;
  version: number;
  versionCompte: number;
  cleVersionGroupe: number;
  /** Le destinataire est membre actif ; son arrivée si l'historique lui est caché. */
  membre: { historiqueDepuis: Date | null } | null;
  /** La version actuelle de la clé de compte du destinataire, s'il en a une. */
  versionCompteDestinataire: number | undefined;
  /** Les versions dont le déposant a un emballage, ou qu'il a créées. */
  detenues: Set<number>;
  versions: VersionDatee[];
}): string | null {
  if (!p.membre) return "PAS_MEMBRE";
  if (p.versionCompteDestinataire !== p.versionCompte) return "VERSION_COMPTE";
  if (p.version > p.cleVersionGroupe) return "VERSION_INCONNUE";
  if (p.destinataire !== p.deposant && !p.detenues.has(p.version)) return "VERSION_NON_DETENUE";
  if (!versionsDues(p.versions, p.membre.historiqueDepuis).includes(p.version)) return "HISTORIQUE_CACHE";
  return null;
}
