import { prisma } from "@/lib/prisma";
import { sfuConfigure } from "@/lib/sfu-cloudflare";

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

/**
 * Le moteur des APPELS DE GROUPE ET DES RÉUNIONS (07/11/2026) :
 *  - `mesh` : le système d'origine, une connexion par participant ;
 *  - `sfu` : le SFU de Cloudflare, une seule connexion par participant vers
 *    Cloudflare, qui redistribue. Voir `sfu-cloudflare.ts`.
 *
 * Le tête-à-tête reste TOUJOURS en direct (décision du user) : à deux, le
 * chemin direct est le meilleur, et il ne coûte rien.
 */
export type MoteurGroupes = "mesh" | "sfu";

export interface ReglagesAppels {
  relaisPrincipal: RelaisPrincipal;
  moteurGroupes: MoteurGroupes;
}

export const REGLAGES_APPELS_DEFAUT: ReglagesAppels = {
  relaisPrincipal: "cloudflare",
  moteurGroupes: "mesh",
};

const DUREE_CACHE_MS = 10_000;
let cache: { valeur: ReglagesAppels; lu: number } | null = null;

/** Une valeur stockée, ramenée à des réglages valides. */
export function normaliserReglagesAppels(brut: unknown): ReglagesAppels {
  const v = (brut ?? {}) as { relaisPrincipal?: unknown; moteurGroupes?: unknown };
  return {
    relaisPrincipal: v.relaisPrincipal === "nos_relais" ? "nos_relais" : "cloudflare",
    moteurGroupes: v.moteurGroupes === "sfu" ? "sfu" : "mesh",
  };
}

/**
 * Le moteur d'un appel de groupe ou d'une réunion qui COMMENCE, pour ces
 * participants. Fixé une fois pour toutes : une bascule dans la console ne
 * touche pas ce qui est en cours.
 *
 * Le SFU n'est retenu que si les trois conditions tiennent :
 *  - la console l'a choisi ;
 *  - il est configuré sur ce serveur (sinon personne ne pourrait s'y joindre) ;
 *  - TOUS les participants ont une application qui sait le rejoindre
 *    (`users.capacite_sfu`). Un seul téléphone pas encore mis à jour, et le
 *    groupe reste en mesh : il aurait sonné sans pouvoir rien entendre.
 */
export async function moteurPour(userIds: string[]): Promise<MoteurGroupes> {
  const reglages = await lireReglagesAppels();
  if (reglages.moteurGroupes !== "sfu" || !sfuConfigure()) return "mesh";
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return "mesh";
  const capables = await prisma.user.count({ where: { id: { in: ids }, capaciteSfu: true } });
  return capables === ids.length ? "sfu" : "mesh";
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
