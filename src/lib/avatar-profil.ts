import { prisma } from "@/lib/prisma";
import { formesStockeesPour } from "@/lib/avatar";
import { ESPACE_PROFIL, idAvatarDepuisUrl } from "@/lib/seau-profil.mjs";
import { readStored } from "@/modules/media/storage";
import {
  ecrirePhotoProfil,
  effacerPhotoProfil,
  profilConfigure,
  taillePhotoProfil,
} from "@/modules/media/r2-profil";

/**
 * CE QUI ENTRE DANS LE SEAU DES PHOTOS DE PROFIL, ET QUAND ÇA EN SORT.
 *
 * 🔴 UNE PHOTO ENTRE quand elle est la photo d'un compte ou d'un groupe : à
 * l'instant où on la choisit (routes de profil et de groupe), et sinon au
 * premier affichage (`/api/avatars/:id`) — ce qui couvre les photos d'avant ce
 * seau, et celles que l'application de l'équipe écrit directement en base.
 *
 * 🔴 ELLE SORT dès que plus personne ne l'a pour photo. Le serveur, lui,
 * cessait déjà de la montrer ; un seau public, non : son adresse resterait
 * lisible tant qu'on n'efface pas l'objet. Sans ce retrait, changer de photo ne
 * retirerait jamais l'ancienne d'Internet.
 *
 * ⚠️ L'ORIGINAL RESTE DANS LE SEAU PRIVÉ. Le seau public n'en est qu'une copie :
 * débrancher `STOCKAGE_PROFIL` suffit à revenir en arrière, sans rien perdre.
 *
 * ⚠️ JAMAIS PLUS QUE CE QUI EST DÉJÀ PUBLIC. Seulement une image, en clair, que
 * son PROPRIÉTAIRE a mise en photo — de son compte, ou d'un groupe dont il est
 * membre. Quelqu'un qui collerait en photo l'identifiant d'une image reçue en
 * discussion ne la ferait pas sortir dans un seau public.
 */

export interface MediaAvatar {
  id: string;
  ownerId: string;
  url: string;
  mimeType: string;
  espace: string | null;
  chiffre: boolean;
}

/** Une même photo n'est copiée qu'une fois à la fois, même vue par cent écrans. */
const enCours = new Set<string>();

/** Les comptes qui l'ont pour photo, et les membres des groupes qui l'ont pour photo. */
async function references(idMedia: string) {
  const formes = formesStockeesPour(idMedia);
  const [comptes, groupes] = await Promise.all([
    prisma.user.findMany({ where: { avatarUrl: { in: formes } }, select: { id: true } }),
    prisma.conversation.findMany({
      where: { avatarUrl: { in: formes } },
      select: { participants: { select: { userId: true } } },
    }),
  ]);
  return {
    total: comptes.length + groupes.length,
    autorises: new Set([
      ...comptes.map((c) => c.id),
      ...groupes.flatMap((g) => g.participants.map((p) => p.userId)),
    ]),
  };
}

/**
 * Copie une photo de profil dans le seau, puis le note en base.
 * Rend `true` si elle y est désormais. Ne lève pas pour un refus de principe.
 *
 * ⚠️ L'ORDRE COMPTE : copier, RELIRE la taille, et seulement alors écrire
 * `espace = 'profil'`. Inversé, `/api/avatars/:id` renverrait vers un objet
 * absent — une photo vide pour tous les contacts, sans une erreur nulle part.
 */
export async function publierAvatar(media: MediaAvatar, octets?: Buffer): Promise<boolean> {
  if (!profilConfigure() || enCours.has(media.id)) return false;
  if (media.espace !== null || media.chiffre || !media.mimeType.startsWith("image/")) return false;
  enCours.add(media.id);
  try {
    const refs = await references(media.id);
    if (!refs.autorises.has(media.ownerId)) return false;
    const corps = octets ?? (await readStored(media.url, media.espace));
    await ecrirePhotoProfil(media.url, corps, media.mimeType);
    const taille = await taillePhotoProfil(media.url);
    if (taille !== corps.length) {
      throw new Error(`photo relue à ${taille} octets au lieu de ${corps.length}`);
    }
    // Seulement si personne n'a changé la marque entre-temps.
    const r = await prisma.mediaFile.updateMany({
      where: { id: media.id, espace: null },
      data: { espace: ESPACE_PROFIL },
    });
    return r.count === 1;
  } finally {
    enCours.delete(media.id);
  }
}

/**
 * Retire une photo du seau si plus personne ne l'a pour photo.
 *
 * ⚠️ EFFACER D'ABORD, LA MARQUE ENSUITE. Une marque retirée sur un objet resté
 * en ligne serait une photo publique que plus rien ne retrouve — le seul cas
 * qu'on ne veut jamais. Dans l'autre sens, le pire est une marque en trop, que
 * `scripts/avatars-profil.mjs --nettoyer` rattrape.
 */
export async function depublierAvatar(idMedia: string): Promise<void> {
  const media = await prisma.mediaFile.findUnique({
    where: { id: idMedia },
    select: { url: true, espace: true },
  });
  if (!media || media.espace !== ESPACE_PROFIL || !profilConfigure()) return;
  if ((await references(idMedia)).total > 0) return;
  await effacerPhotoProfil(media.url);
  await prisma.mediaFile.updateMany({
    where: { id: idMedia, espace: ESPACE_PROFIL },
    data: { espace: null },
  });
}

/**
 * Après un changement de photo (compte ou groupe) : publie la nouvelle, retire
 * l'ancienne. En arrière-plan — la réponse au client n'attend pas Cloudflare.
 */
export function apresChangementDePhoto(ancienne: string | null | undefined, nouvelle: string | null | undefined): void {
  const idAncienne = idAvatarDepuisUrl(ancienne ?? null);
  const idNouvelle = idAvatarDepuisUrl(nouvelle ?? null);
  if (idAncienne === idNouvelle) return;
  if (!profilConfigure()) return;

  if (idNouvelle) {
    void prisma.mediaFile
      .findUnique({
        where: { id: idNouvelle },
        select: { id: true, ownerId: true, url: true, mimeType: true, espace: true, chiffre: true },
      })
      .then((m) => (m ? publierAvatar(m) : false))
      .catch((e) => console.error("[photos de profil] copie impossible :", e));
  }
  if (idAncienne) {
    void depublierAvatar(idAncienne).catch((e) =>
      console.error("[photos de profil] retrait de l'ancienne impossible :", e),
    );
  }
}
