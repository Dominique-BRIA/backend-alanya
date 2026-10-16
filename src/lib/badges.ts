import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { TYPE_COMPTE_OFFICIEL } from "@/lib/compte-officiel.mjs";

/**
 * LES BADGES À CÔTÉ DU NOM — décidés ICI, affichés tels quels par les clients
 * (décision du user, 16/10/2026).
 *
 * « Redéployer le client est très difficile » : le serveur dit donc QUI a un
 * badge et À QUOI il ressemble (`{ type, image, libelle }`), et le client se
 * borne à dessiner l'image avec le libellé en info-bulle. Changer l'image, le
 * libellé, ou masquer un badge se fait depuis la console (réglage `badges`),
 * sans nouvelle version de l'application.
 *
 * Les RÈGLES restent dans le code — ce sont celles du métier :
 *   - `officiel` : le compte « Alanya Work » (type_compte 5) ;
 *   - `verifie`  : une entreprise dont la vérification est accordée et pas
 *                  encore échue (`verification_statut` 2, `verifie_jusqua`).
 *
 * FACULTATIF POUR LE CLIENT : un client ancien ignore le champ `badge`.
 */

export const TYPES_BADGE = ["officiel", "verifie"] as const;
export type TypeBadge = (typeof TYPES_BADGE)[number];

export type ApparenceBadge = { actif: boolean; image: string; libelle: string };
export type Badge = { type: TypeBadge; image: string; libelle: string };

export const CLE_REGLAGE_BADGES = "badges";

export const BADGES_PAR_DEFAUT: Record<TypeBadge, ApparenceBadge> = {
  officiel: { actif: true, image: "/badges/officiel.png", libelle: "Compte officiel" },
  verifie: { actif: true, image: "/badges/verifie.png", libelle: "Entreprise vérifiée" },
};

export const apparenceSchema = z.object({
  actif: z.boolean(),
  // Chemin servi par ce serveur (`/badges/…`) ou URL https complète.
  image: z.string().trim().max(500).regex(/^(\/[^\s]*|https:\/\/[^\s]+)$/, "Chemin /… ou URL https://…"),
  libelle: z.string().trim().min(1).max(40),
});

const VERIFICATION_ACCORDEE = 2;

/** Le réglage, fusionné avec les valeurs par défaut (un type absent garde son défaut). */
export async function lireApparences(): Promise<Record<TypeBadge, ApparenceBadge>> {
  const r = await prisma.gestionReglage.findUnique({ where: { cle: CLE_REGLAGE_BADGES } });
  const brut = (r?.valeur as Partial<Record<TypeBadge, Partial<ApparenceBadge>>> | null) ?? {};
  const out = { ...BADGES_PAR_DEFAUT };
  for (const t of TYPES_BADGE) out[t] = { ...BADGES_PAR_DEFAUT[t], ...(brut[t] ?? {}) };
  return out;
}

// Lu à chaque liste de conversations : 30 s de cache suffisent, la console
// invalide elle-même après un enregistrement.
let cache: { valeur: Record<TypeBadge, ApparenceBadge>; jusqua: number } | null = null;
export function oublierApparences() {
  cache = null;
}
async function apparences() {
  if (cache && cache.jusqua > Date.now()) return cache.valeur;
  const valeur = await lireApparences();
  cache = { valeur, jusqua: Date.now() + 30_000 };
  return valeur;
}

function urlImage(image: string): string {
  return image.startsWith("/") ? `${env.publicBaseUrl}${image}` : image;
}

type CompteBadge = {
  typeCompte: number;
  verificationStatut?: number | null;
  verifieJusqua?: Date | null;
};

/** Quel badge revient à ce compte ? (règle seule, sans l'apparence) */
export function typeBadge(u: CompteBadge, maintenant = new Date()): TypeBadge | null {
  if (u.typeCompte === TYPE_COMPTE_OFFICIEL) return "officiel";
  if (
    u.verificationStatut === VERIFICATION_ACCORDEE &&
    (!u.verifieJusqua || u.verifieJusqua > maintenant)
  ) {
    return "verifie";
  }
  return null;
}

/**
 * Prépare une fonction `compte → badge | null` pour toute une réponse : le
 * réglage n'est lu qu'une fois.
 */
export async function preparerBadges(): Promise<(u: CompteBadge | null | undefined) => Badge | null> {
  const a = await apparences();
  const maintenant = new Date();
  return (u) => {
    if (!u) return null;
    const type = typeBadge(u, maintenant);
    if (!type || !a[type].actif) return null;
    return { type, image: urlImage(a[type].image), libelle: a[type].libelle };
  };
}
