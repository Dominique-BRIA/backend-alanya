import { prisma } from "@/lib/prisma";
import { HttpError } from "@/lib/http";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";
import { previensDesPersonnes } from "@/lib/salle-temps-reel";
import {
  calculerManquants,
  motifRefusDepot,
  versionsCompletes,
} from "@/lib/e2ee-v2-regles";

/**
 * CHIFFREMENT DES GROUPES, VERSION 2 — ce que partagent les routes du lot 2
 * (11/11/2026). Conception : `docs/2026-11-11-e2ee-groupes-v2-conception.md`.
 *
 * 🔴 LE SERVEUR NE VOIT QUE DES CHIFFRÉS ET DES NUMÉROS. Une clé de compte
 * privée est chiffrée par la clé maîtresse de son propriétaire ; un emballage
 * est scellé pour une clé de compte publique. Ce module ne fait que vérifier
 * QUI a le droit de déposer QUOI pour QUI, et dire ce qui manque.
 */

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Une clé publique X25519 en base64 : 32 octets, donc 44 caractères. */
export function lirePublique(brut: unknown): string {
  if (typeof brut !== "string" || brut.length !== 44 || !BASE64.test(brut)) {
    throw new HttpError(400, "Clé publique invalide", "CLE_INVALIDE");
  }
  return brut;
}

/** Un chiffré en base64, borné. */
export function lireChiffre(brut: unknown, max: number, nom = "corps"): string {
  if (typeof brut !== "string" || brut.length === 0 || brut.length > max || !BASE64.test(brut)) {
    throw new HttpError(400, `« ${nom} » invalide`, "CHIFFRE_INVALIDE");
  }
  return brut;
}

export function lireEntierPositif(brut: unknown, nom: string): number {
  if (typeof brut !== "number" || !Number.isInteger(brut) || brut < 1 || brut > 1_000_000) {
    throw new HttpError(400, `« ${nom} » invalide`, "NOMBRE_INVALIDE");
  }
  return brut;
}

/**
 * Le groupe chiffré [convId], dont [userId] est membre actif — ou une erreur.
 */
export async function groupeChiffrePour(convId: string, userId: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    select: {
      id: true,
      isGroup: true,
      e2eeActif: true,
      cleVersion: true,
      participants: { where: { userId, ...MEMBRE_ACTIF }, select: { userId: true } },
    },
  });
  if (!conv) throw new HttpError(404, "Conversation introuvable", "NOT_FOUND");
  if (conv.participants.length === 0) throw new HttpError(403, "Vous n'êtes pas membre", "FORBIDDEN");
  if (!conv.isGroup || !conv.e2eeActif) {
    throw new HttpError(409, "Ce n'est pas un groupe chiffré", "PAS_UN_GROUPE_CHIFFRE");
  }
  return conv;
}

/** Les versions de clé d'un groupe, avec leur date (epoch si inconnue). */
async function versionsDuGroupe(convId: string, cleVersion: number) {
  const lignes = await prisma.e2eeCleVersion.findMany({
    where: { convId },
    select: { version: true, creeLe: true },
  });
  return versionsCompletes(cleVersion, lignes);
}

export type { Manquant } from "@/lib/e2ee-v2-regles";

/**
 * CE QU'IL RESTE À EMBALLER dans un groupe (conception, § 5.6) : pour chaque
 * membre actif qui a une clé de compte, les versions qui lui sont dues et
 * qu'aucun emballage ne lui porte encore (pour SA clé de compte actuelle).
 * `sansCle` : les membres qui n'ont pas encore de clé de compte.
 */
export async function manquants(convId: string, cleVersion: number) {
  const [versions, membres, existants] = await Promise.all([
    versionsDuGroupe(convId, cleVersion),
    prisma.participant.findMany({
      where: { convId, ...MEMBRE_ACTIF },
      select: { userId: true, historiqueDepuis: true },
    }),
    prisma.e2eeEmballage.findMany({
      where: { convId },
      select: { userId: true, version: true, versionCompte: true },
    }),
  ]);
  const cles = await prisma.e2eeCleCompte.findMany({
    where: { userId: { in: membres.map((m) => m.userId) } },
    select: { userId: true, version: true, publique: true },
  });
  return { cleVersion, ...calculerManquants(versions, membres, cles, existants) };
}

/**
 * Les versions qu'un membre peut transmettre aux autres : celles dont il a
 * lui-même un emballage, ou qu'il a créées. Un dépôt pour soi-même est
 * toujours permis — c'est ainsi qu'un appareil qui a déjà la clé (ancien
 * système, création d'une version) commence.
 */
async function versionsDetenues(convId: string, userId: string): Promise<Set<number>> {
  const [miens, crees] = await Promise.all([
    prisma.e2eeEmballage.findMany({ where: { convId, userId }, select: { version: true } }),
    prisma.e2eeCleVersion.findMany({ where: { convId, creePar: userId }, select: { version: true } }),
  ]);
  return new Set([...miens.map((e) => e.version), ...crees.map((c) => c.version)]);
}

export type DemandeEmballage = { userId: string; version: number; versionCompte: number; corps: string };

/**
 * DÉPOSE des emballages (conception, § 9). Chaque emballage est vérifié ; un
 * refus n'empêche pas les autres et est rendu avec son motif. Premier dépôt
 * gagnant : un emballage déjà là n'est pas remplacé.
 */
export async function deposerEmballages(convId: string, deposant: string, demandes: DemandeEmballage[]) {
  const conv = await groupeChiffrePour(convId, deposant);
  const ids = [...new Set(demandes.map((d) => d.userId))];
  const [membres, cles, versions, detenues] = await Promise.all([
    prisma.participant.findMany({
      where: { convId, userId: { in: ids }, ...MEMBRE_ACTIF },
      select: { userId: true, historiqueDepuis: true },
    }),
    prisma.e2eeCleCompte.findMany({ where: { userId: { in: ids } }, select: { userId: true, version: true } }),
    versionsDuGroupe(convId, conv.cleVersion),
    versionsDetenues(convId, deposant),
  ]);
  const membreDe = new Map(membres.map((m) => [m.userId, m]));
  const versionCompteDe = new Map(cles.map((c) => [c.userId, c.version]));

  const acceptes: DemandeEmballage[] = [];
  const refuses: { userId: string; version: number; motif: string }[] = [];
  for (const d of demandes) {
    const motif = motifRefusDepot({
      deposant,
      destinataire: d.userId,
      version: d.version,
      versionCompte: d.versionCompte,
      cleVersionGroupe: conv.cleVersion,
      membre: membreDe.get(d.userId) ?? null,
      versionCompteDestinataire: versionCompteDe.get(d.userId),
      detenues,
      versions,
    });
    if (motif) refuses.push({ userId: d.userId, version: d.version, motif });
    else acceptes.push(d);
  }

  const r =
    acceptes.length === 0
      ? { count: 0 }
      : await prisma.e2eeEmballage.createMany({
          data: acceptes.map((d) => ({
            convId,
            userId: d.userId,
            version: d.version,
            versionCompte: d.versionCompte,
            corps: d.corps,
            deposePar: deposant,
          })),
          skipDuplicates: true,
        });

  // Chaque destinataire (autre que moi) l'apprend : ses appareils relisent.
  const parDestinataire = new Map<string, number[]>();
  for (const d of acceptes) {
    if (d.userId === deposant) continue;
    parDestinataire.set(d.userId, [...(parDestinataire.get(d.userId) ?? []), d.version]);
  }
  for (const [uid, vs] of parDestinataire) {
    await previensDesPersonnes({
      personnes: [uid],
      type: "e2ee_emballage",
      donnees: { convId, versions: [...new Set(vs)] },
    });
  }

  return { deposes: r.count, refuses };
}

/**
 * Prévient les membres d'un groupe chiffré qu'il y a peut-être des
 * emballages à déposer (arrivée, nouvelle clé de compte). Les appareils qui
 * ont les clés demandent alors `GET …/e2ee/manquants` et complètent.
 */
export async function previensManquants(convId: string, sauf?: string): Promise<void> {
  const membres = await prisma.participant.findMany({
    where: { convId, ...MEMBRE_ACTIF },
    select: { userId: true },
  });
  const personnes = membres.map((m) => m.userId).filter((u) => u !== sauf);
  if (personnes.length === 0) return;
  await previensDesPersonnes({ personnes, type: "e2ee_manquants", donnees: { convId } });
}

/** Les groupes chiffrés dont [userId] est membre actif. */
export async function groupesChiffresDe(userId: string): Promise<string[]> {
  const lignes = await prisma.participant.findMany({
    where: { userId, ...MEMBRE_ACTIF, conv: { isGroup: true, e2eeActif: true } },
    select: { convId: true },
  });
  return lignes.map((l) => l.convId);
}
