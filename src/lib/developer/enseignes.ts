import { prisma } from "@/lib/prisma";
import { HttpError } from "@/lib/http";
import { generateUniquePublicNumber } from "@/lib/publicNumber";
import { TYPE_COMPTE_AGENT } from "@/lib/collegues";
import { TYPE_COMPTE_CENTRE, TYPE_COMPTE_CENTRE_VOCAL } from "@/lib/ivr.mjs";

/**
 * LES ENSEIGNES DE L'ESPACE DÉVELOPPEUR (décisions du user, 07/11/2026).
 *
 * Une personne entre dans la console avec son compte Alanya — créé depuis la
 * plateforme développeur ou déjà existant, c'est exactement le même compte.
 * Pour utiliser l'API, elle crée une ENSEIGNE : un nom, et un compte Alanya
 * propre à l'enseigne, avec son numéro. Les clés API sont rattachées à
 * l'enseigne, et c'est le compte de l'enseigne qui envoie les messages.
 *
 * 🔴 POURQUOI UN COMPTE À PART. Avant, la personne envoyait en son propre nom :
 * le serveur écrivait donc dans ses conversations, ce qui interdisait de les
 * chiffrer de bout en bout (motif `EMETTEUR_API`, retiré). Le compte de
 * l'enseigne est de type 6, hors de la liste des types qui chiffrent : l'API
 * peut toujours y écrire, et le compte personnel garde tout son chiffrement.
 *
 * Le mot « organisation » était pris par le référentiel de l'équipe (volet
 * Organisation & centre d'appels) : d'où « enseigne ». La table garde son nom
 * d'origine, `developer_accounts`, lue aussi par le second système.
 */

/** Le compte Alanya d'une enseigne : il envoie, personne ne s'y connecte. */
export const TYPE_COMPTE_ENSEIGNE = 6;

/**
 * Les types de compte qui NE PEUVENT PAS créer d'enseigne : agent, centre
 * d'appels, centre vocal (décision du user), et le compte d'une enseigne
 * lui-même. Tous les autres le peuvent.
 */
export const TYPES_SANS_ENSEIGNE: readonly number[] = [
  TYPE_COMPTE_AGENT,
  TYPE_COMPTE_CENTRE,
  TYPE_COMPTE_CENTRE_VOCAL,
  TYPE_COMPTE_ENSEIGNE,
];

export function peutCreerUneEnseigne(typeCompte: number): boolean {
  return !TYPES_SANS_ENSEIGNE.includes(typeCompte);
}

/**
 * Le nombre d'enseignes par personne : réglé dans le backoffice (réglage
 * `developpeur`, champ `enseignesParPersonne`). Toute la gestion des comptes
 * développeur y sera construite plus tard ; d'ici là, le repli vaut 1.
 */
export const CLE_REGLAGE_DEVELOPPEUR = "developpeur";
export const ENSEIGNES_PAR_PERSONNE_PAR_DEFAUT = 1;

export async function limiteDEnseignes(): Promise<number> {
  try {
    const r = await prisma.gestionReglage.findUnique({ where: { cle: CLE_REGLAGE_DEVELOPPEUR } });
    const v = (r?.valeur as { enseignesParPersonne?: unknown } | null)?.enseignesParPersonne;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  } catch {
    // Réglage illisible : le repli, plutôt qu'une console inutilisable.
  }
  return ENSEIGNES_PAR_PERSONNE_PAR_DEFAUT;
}

/**
 * Créer une enseigne est une action sensible : elle donne le droit d'écrire à
 * n'importe quel utilisateur d'Alanya. Pour un compte qui a l'application sur
 * un téléphone, on demande donc un code reçu dans l'application (la même
 * double authentification que la connexion web, `deux-etapes.ts`), validé il
 * y a moins de 30 minutes.
 *
 * ⚠️ UN COMPTE SANS APPLICATION n'a nulle part où recevoir ce code — typiquement
 * un compte ouvert depuis la plateforme développeur. Il est alors protégé par
 * son mot de passe seul, comme sa connexion.
 */
export const DUREE_CONFIRMATION_MS = 30 * 60_000;

export async function confirmationRequise(userId: string): Promise<boolean> {
  const appareils = await prisma.pushDevice.count({ where: { userId } });
  if (appareils === 0) return false;
  const recent = await prisma.defiConnexion.findFirst({
    where: {
      userId,
      statut: "valide",
      creeLe: { gte: new Date(Date.now() - DUREE_CONFIRMATION_MS) },
    },
    select: { id: true },
  });
  return recent === null;
}

/** Ce que la console lit d'une enseigne. */
export const SELECTION_ENSEIGNE = {
  id: true,
  nom: true,
  createdAt: true,
  user: { select: { publicNumber: true } },
  _count: { select: { apiKeys: { where: { isActive: true } } } },
} as const;

export function presenterEnseigne(e: {
  id: string;
  nom: string | null;
  createdAt: Date;
  user: { publicNumber: string };
  _count: { apiKeys: number };
}) {
  return {
    id: e.id,
    nom: e.nom ?? "",
    numero: e.user.publicNumber,
    clesActives: e._count.apiKeys,
    creeLe: e.createdAt.toISOString(),
  };
}

/**
 * Crée l'enseigne ET son compte Alanya, dans une même transaction.
 *
 * ⚠️ La limite se compte SOUS VERROU : la ligne de la personne est verrouillée
 * (`FOR UPDATE`) avant de compter, sinon deux clics simultanés passeraient
 * tous deux sous la limite.
 */
export async function creerEnseigne(proprietaireId: string, nom: string) {
  const limite = await limiteDEnseignes();
  const publicNumber = await generateUniquePublicNumber();

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "users" WHERE "alanyaID" = ${proprietaireId}::uuid FOR UPDATE`;

    const existantes = await tx.developerAccount.count({ where: { proprietaireId } });
    if (existantes >= limite) {
      throw new HttpError(
        409,
        `Vous avez atteint le nombre maximal d'enseignes (${limite}). Contactez l'équipe Alanya pour en ouvrir davantage.`,
        "LIMITE_ENSEIGNES",
      );
    }

    const compte = await tx.user.create({
      data: {
        typeCompte: TYPE_COMPTE_ENSEIGNE,
        publicNumber,
        nom,
        pseudo: nom,
        email: null,
        emailVerified: false,
      },
      select: { id: true },
    });

    return tx.developerAccount.create({
      data: { userId: compte.id, proprietaireId, nom },
      select: SELECTION_ENSEIGNE,
    });
  });
}

/**
 * L'enseigne `enseigneId`, si elle appartient à `proprietaireId`. Sinon 404 —
 * et non 403 : dire « elle existe mais pas à vous » renseignerait sur les
 * enseignes des autres.
 */
export async function enseigneDuProprietaire(
  proprietaireId: string,
  enseigneId: string | null | undefined,
) {
  if (!enseigneId) throw new HttpError(400, "Enseigne manquante.", "ENSEIGNE_MANQUANTE");
  const enseigne = await prisma.developerAccount.findFirst({
    where: { id: enseigneId, proprietaireId },
    select: { id: true, userId: true, nom: true },
  });
  if (!enseigne) throw new HttpError(404, "Enseigne introuvable.", "ENSEIGNE_INTROUVABLE");
  return enseigne;
}

/**
 * Supprime l'enseigne : on supprime son compte Alanya, comme on supprime un
 * compte depuis l'application, et la base emporte le reste en cascade —
 * l'enseigne, ses clés (qui cessent aussitôt de marcher), son journal, son
 * webhook, ses codes de vérification. Le compte de la personne n'est pas touché.
 */
export async function supprimerEnseigne(proprietaireId: string, enseigneId: string) {
  const enseigne = await enseigneDuProprietaire(proprietaireId, enseigneId);
  await prisma.user.delete({ where: { id: enseigne.userId } });
}
