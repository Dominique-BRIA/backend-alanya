/**
 * Les langues du contenu officiel (bienvenue, statuts, diffusions) — miroir de
 * `Alanya2026/Alanya-backend/src/utils/localeContent.js` et de
 * `lib/content-locales.ts` de la console (24/10/2026).
 *
 * Trois langues de rédaction : français, anglais, chinois. Le français et
 * l'anglais sont obligatoires pour publier. Un lecteur dont la langue n'est
 * pas rédigée reçoit l'anglais, puis le français (leur `FALLBACK_CHAIN`).
 *
 * La langue du lecteur est celle de son application (`users.langue`, voir
 * `src/lib/langue-compte.ts`).
 */
export const LANGUES_CONTENU = ["fr", "en", "zh"] as const;
export type LangueContenu = (typeof LANGUES_CONTENU)[number];
export type Traductions = Partial<Record<LangueContenu, string>>;

export const LANGUES_REQUISES: readonly LangueContenu[] = ["fr", "en"];
const REPLI: readonly LangueContenu[] = ["en", "fr"];

/** Ne garde que les langues connues, textes nettoyés, vides retirés. */
export function nettoyerTraductions(brut: unknown, max: number): Traductions {
  const t: Traductions = {};
  if (!brut || typeof brut !== "object") return t;
  for (const l of LANGUES_CONTENU) {
    const v = (brut as Record<string, unknown>)[l];
    if (typeof v === "string" && v.trim()) t[l] = v.trim().slice(0, max);
  }
  return t;
}

/** Les langues requises encore vides : ce qui bloque la publication. */
export function languesManquantes(t: Traductions): LangueContenu[] {
  return LANGUES_REQUISES.filter((l) => !t[l]);
}

/** Le texte à montrer à un lecteur : sa langue, sinon l'anglais, sinon le français. */
export function texteDans(t: Traductions, langue: string | null | undefined): string | null {
  const l = (langue ?? "").toLowerCase() as LangueContenu;
  if ((LANGUES_CONTENU as readonly string[]).includes(l) && t[l]) return t[l]!;
  for (const r of REPLI) if (t[r]) return t[r]!;
  return null;
}
