import { prisma } from "@/lib/prisma";

/**
 * LES RÉGLAGES DES APPELS, PILOTÉS DEPUIS LA CONSOLE (07/11/2026).
 *
 * `relaisPrincipal` — quels relais TURN passent EN PREMIER dans la liste que
 * `/api/calls/ice` donne aux téléphones et aux navigateurs :
 *  - `cloudflare` : le TURN de Cloudflare d'abord, nos relais coturn en
 *    secours (le choix du 03/11/2026, valeur par défaut) ;
 *  - `nos_relais` : l'inverse, `turn.kemita.eu` et `turn.alanya226.com`
 *    d'abord, Cloudflare en secours.
 *
 * ⚠️ POURQUOI L'ORDRE SUFFIT. WebRTC (Chrome comme flutter_webrtc) donne aux
 * candidats d'un relais une priorité qui DÉCROÎT avec sa place dans la liste.
 * Quand les deux relais répondent, c'est donc le premier qui porte l'appel ;
 * quand il ne passe pas depuis le réseau du téléphone, l'autre prend le relais
 * sans attente, puisque tous sont essayés en même temps. Un appel en direct
 * (sans relais) reste en direct, quel que soit ce réglage.
 *
 * Les applications redemandent la liste à chaque appel : une bascule vaut pour
 * les appels suivants, pas pour ceux en cours.
 *
 * Relu au plus toutes les 10 s, comme la maintenance (`maintenance.ts`).
 */
export const CLE_REGLAGES_APPELS = "appels.reglages";

export type RelaisPrincipal = "cloudflare" | "nos_relais";

export interface ReglagesAppels {
  relaisPrincipal: RelaisPrincipal;
}

export const REGLAGES_APPELS_DEFAUT: ReglagesAppels = { relaisPrincipal: "cloudflare" };

const DUREE_CACHE_MS = 10_000;
let cache: { valeur: ReglagesAppels; lu: number } | null = null;

/** Une valeur stockée, ramenée à des réglages valides. */
export function normaliserReglagesAppels(brut: unknown): ReglagesAppels {
  const v = (brut ?? {}) as { relaisPrincipal?: unknown };
  return {
    relaisPrincipal: v.relaisPrincipal === "nos_relais" ? "nos_relais" : "cloudflare",
  };
}

export async function lireReglagesAppels(options: { frais?: boolean } = {}): Promise<ReglagesAppels> {
  if (!options.frais && cache && Date.now() - cache.lu < DUREE_CACHE_MS) return cache.valeur;
  let valeur = REGLAGES_APPELS_DEFAUT;
  try {
    const r = await prisma.gestionReglage.findUnique({ where: { cle: CLE_REGLAGES_APPELS } });
    valeur = normaliserReglagesAppels(r?.valeur);
  } catch {
    // La base ne répond pas : les appels partent avec le choix par défaut.
    valeur = REGLAGES_APPELS_DEFAUT;
  }
  cache = { valeur, lu: Date.now() };
  return valeur;
}

/** Après une bascule depuis la console : effet immédiat pour la route qui l'a reçue. */
export function oublierReglagesAppels() {
  cache = null;
}
