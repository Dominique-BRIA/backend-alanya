import { prisma } from "./prisma";

// Plafond de participants d'une reunion : LA source unique de verite.
//
// Tout ce qui fait entrer quelqu'un dans une salle — creation de reunion, ajout
// de participants, acceptation d'une demande d'invitation, entree par le join —
// doit passer par `limitesPour()`. Un seul chemin de resolution, sinon deux
// endroits finiront par repondre deux chiffres differents pour la meme reunion,
// et l'un des deux laissera entrer une personne de trop.
//
// POURQUOI UN PLAFOND. L'architecture des reunions est un MAILLAGE : aucun
// serveur ne melange les flux, chaque participant ouvre une connexion vers
// CHACUN des autres et encode son flux autant de fois qu'il a
// d'interlocuteurs. A n personnes, chacun tient n-1 connexions, n-1 encodages
// et n-1 decodages. Le cout ne pese donc pas sur nos serveurs — ils ne voient
// rien passer — mais sur le telephone et l'ordinateur de chaque participant.
// Depasser le plafond ne degrade pas un service central : cela fait lacher les
// machines des gens. C'est une limite PHYSIQUE, pas une offre commerciale, et
// c'est pour cela que les bornes plus bas sont serrees.

/// Valeurs par defaut, EN DUR.
///
/// Elles ne sont pas la copie inutile de la ligne globale posee en base par la
/// migration : elles en sont le FILET. Une base neuve, une table vide, une
/// migration pas encore appliquee, une lecture qui echoue — dans tous ces cas
/// l'application doit continuer a tenir des reunions avec des chiffres justes
/// plutot que de refuser tout le monde ou de n'imposer aucune borne.
///
/// 9 en audio : chacun emet 8 flux Opus a ~40 kbit/s, soit ~320 kbit/s
/// montants, tenable y compris en mobile.
/// 6 en video : chacun emet 5 flux a ~300 kbit/s, soit ~1,5 Mbit/s montants et
/// 5 decodages simultanes — deja le haut de ce qu'un portable de milieu de
/// gamme soutient sans chauffer.
export const LIMITE_AUDIO_DEFAUT = 9;
export const LIMITE_VIDEO_DEFAUT = 6;

/// Bornes de ce que le superuser peut ECRIRE. Elles ne bornent pas ce qu'il
/// veut, elles bornent ce que l'architecture peut honorer.
///
/// PLANCHER 2. Une reunion a une personne n'est pas une reunion : c'est un
/// appareil qui parle seul. A 1, plus aucune reunion ne peut se tenir ; a 0 ou
/// en negatif, la creation elle-meme devient impossible et l'application parait
/// cassee sans qu'aucune erreur ne le dise. Un plafond doit pouvoir etre baisse
/// — c'est demande — mais pas jusqu'a fermer la fonctionnalite : eteindre les
/// reunions est une decision de produit, elle ne doit pas se prendre par
/// inadvertance en tapant un chiffre dans un champ.
///
/// PLAFONDS 20 ET 12. Ce sont les points ou le maillage cesse d'etre honnete.
/// A 20 en audio, chacun tient 19 connexions et ~760 kbit/s montants : lourd,
/// encore possible sur un poste fixe filaire. A 12 en video, chacun emet
/// ~3,3 Mbit/s et decode 11 flux : c'est deja au-dela de ce que la plupart des
/// portables soutiennent, et bien au-dela d'un mobile. Autoriser 10 000, ou
/// meme 100, ne donnerait pas une grande reunion : cela donnerait une salle qui
/// se fige pour tout le monde, avec un support incapable d'expliquer pourquoi.
/// Le maximum audio est PLUS HAUT que le maximum video parce qu'un flux audio
/// coute environ dix fois moins qu'un flux video — deux couts differents, deux
/// bornes differentes.
///
/// ⚠️ Ces deux plafonds hauts sont des bornes de SECURITE, pas des valeurs
/// recommandees. Au-dela des defauts (9 / 6), la qualite se degrade pour tout
/// le monde, et c'est a l'entreprise qui les releve de l'assumer.
export const PLAFOND_MIN = 2;
export const PLAFOND_MAX_AUDIO = 20;
export const PLAFOND_MAX_VIDEO = 12;

/// `Meeting.type_media` : 1 = audio, 2 = video. Repris ici pour que les
/// appelants n'aient pas a redire ces deux nombres a chaque comparaison.
export const TYPE_MEDIA_AUDIO = 1;
export const TYPE_MEDIA_VIDEO = 2;

/// Code d'erreur renvoye quand la salle est pleine. Constant : le client web et
/// le client Flutter s'y adossent pour distinguer ce refus des autres 409.
export const CODE_SALLE_PLEINE = "MEETING_FULL";

/// Les deux plafonds applicables a un utilisateur.
///
/// ⚠️ CONVENTION DE COMPTAGE, valable partout : ces nombres comptent les
/// PERSONNES DANS LA SALLE, ORGANISATEUR COMPRIS — et non les invites. Une
/// reunion video a 6 signifie l'organisateur plus cinq. Compter autrement d'un
/// appel a l'autre laisserait passer une personne de trop a chaque creation.
export interface LimitesReunion {
  audio: number;
  video: number;
}

/// D'ou vient le plafond retenu. Sert l'affichage d'administration : « 8 en
/// video » ne veut rien dire si on ne sait pas si c'est le reglage de
/// l'entreprise, celui de l'application, ou le defaut du code.
export type SourceLimites = "entreprise" | "globale" | "defaut";

export interface LimitesResolues extends LimitesReunion {
  source: SourceLimites;
}

/// Ramene une valeur lue en base dans les bornes tenables.
///
/// Les routes d'administration valident deja ce qu'elles ecrivent, mais elles
/// ne sont pas le seul chemin vers cette table : un UPDATE passe a la main en
/// production, un import, une restauration partielle. Un 0 arrive par cette
/// porte fermerait toutes les reunions, un 500 ferait fondre les machines. On
/// prefere servir une valeur tenable et le dire dans les journaux plutot que
/// d'obeir a une donnee aberrante.
function borner(valeur: number, maximum: number, defaut: number): number {
  if (!Number.isFinite(valeur)) return defaut;
  const entier = Math.trunc(valeur);
  if (entier < PLAFOND_MIN) {
    console.warn(
      `[limites-reunion] plafond ${entier} lu en base, sous le plancher ${PLAFOND_MIN} : ramene au plancher`,
    );
    return PLAFOND_MIN;
  }
  if (entier > maximum) {
    console.warn(
      `[limites-reunion] plafond ${entier} lu en base, au-dessus du maximum ${maximum} : ramene au maximum`,
    );
    return maximum;
  }
  return entier;
}

/// Forme minimale attendue en entree de la resolution — c'est ce que les deux
/// lectures ci-dessous selectionnent.
interface LignePlafond {
  idCompany: number | null;
  maxAudio: number;
  maxVideo: number;
}

/// LA regle de precedence, ecrite une seule fois : le plus precis l'emporte.
///
///   plafond de l'entreprise  >  plafond global  >  defauts en dur
///
/// `lignes` contient AU PLUS deux elements — la ligne globale et celle de
/// l'entreprise concernee — l'unicite de portee etant garantie en base (index
/// unique sur `idcompany`, index unique partiel sur les lignes globales).
function resoudre(lignes: LignePlafond[]): LimitesResolues {
  const entreprise = lignes.find((l) => l.idCompany !== null);
  const globale = lignes.find((l) => l.idCompany === null);
  const retenue = entreprise ?? globale;

  if (!retenue) {
    return {
      audio: LIMITE_AUDIO_DEFAUT,
      video: LIMITE_VIDEO_DEFAUT,
      source: "defaut",
    };
  }

  return {
    audio: borner(retenue.maxAudio, PLAFOND_MAX_AUDIO, LIMITE_AUDIO_DEFAUT),
    video: borner(retenue.maxVideo, PLAFOND_MAX_VIDEO, LIMITE_VIDEO_DEFAUT),
    source: entreprise ? "entreprise" : "globale",
  };
}

/// Plafonds applicables a un utilisateur : entreprise, sinon global, sinon
/// defauts.
///
/// UNE SEULE REQUETE, et c'est delibere : cette fonction est appelee sur le
/// chemin de la creation d'une reunion et de chaque ajout de participants. Le
/// filtre sur la relation (`company.Users.some`) fait faire au moteur le
/// rapprochement utilisateur → entreprise → plafond en un seul aller-retour,
/// la ou une lecture de l'utilisateur PUIS une lecture des plafonds en
/// demanderait deux. Elle rend au plus deux lignes.
///
/// ⚠️ NE JAMAIS L'APPELER DANS UNE BOUCLE sur les participants : le plafond
/// depend de l'organisateur, pas de chaque invite. On le resout une fois, puis
/// on compte.
///
/// POURQUOI PAS DE SQL BRUT. Une requete `$queryRaw` aurait fait la meme chose
/// en une passe, mais ce depot n'en contient aucune et elle figerait les noms
/// de colonnes physiques dans du TypeScript, hors de portee du typage.
///
/// POURQUOI PAS DE CACHE. Un plafond change rarement, la tentation est forte.
/// Mais l'application tourne en plusieurs instances : un cache local rendrait
/// une baisse de plafond effective ici et pas la, pendant un temps que
/// personne ne pourrait constater. Une lecture indexee par reunion creee est
/// un prix negligeable a cote de cette incoherence.
export async function limitesPour(userId: string): Promise<LimitesReunion> {
  try {
    const lignes = await prisma.limiteReunion.findMany({
      where: {
        OR: [
          // La ligne globale.
          { idCompany: null },
          // Celle de l'entreprise de cet utilisateur, s'il en a une et si elle
          // a un plafond propre.
          { company: { Users: { some: { id: userId } } } },
        ],
      },
      select: { idCompany: true, maxAudio: true, maxVideo: true },
    });

    const { audio, video } = resoudre(lignes);
    return { audio, video };
  } catch (err) {
    // La table peut manquer (migration pas encore appliquee), la base peut
    // etre indisponible une seconde. Aucune de ces situations ne justifie de
    // faire echouer une creation de reunion parfaitement legitime : on retombe
    // sur les defauts, qui sont justes, et on laisse une trace.
    console.error(
      "[limites-reunion] lecture des plafonds impossible, defauts appliques :",
      err instanceof Error ? err.message : err,
    );
    return { audio: LIMITE_AUDIO_DEFAUT, video: LIMITE_VIDEO_DEFAUT };
  }
}

/// Meme resolution, mais pour une PORTEE et non pour un utilisateur, et en
/// disant d'ou vient le chiffre.
///
/// Sert les ecrans d'administration : « quel plafond s'applique aujourd'hui a
/// cette entreprise ? », question a laquelle la seule ligne `limite_reunion`
/// de l'entreprise ne repond pas quand elle n'existe pas.
///
/// `idCompany` nul = on demande la portee globale.
export async function limitesPourEntreprise(
  idCompany: number | null,
): Promise<LimitesResolues> {
  try {
    const lignes = await prisma.limiteReunion.findMany({
      where: {
        OR: [
          { idCompany: null },
          ...(idCompany === null ? [] : [{ idCompany }]),
        ],
      },
      select: { idCompany: true, maxAudio: true, maxVideo: true },
    });
    return resoudre(lignes);
  } catch (err) {
    console.error(
      "[limites-reunion] lecture des plafonds impossible, defauts appliques :",
      err instanceof Error ? err.message : err,
    );
    return {
      audio: LIMITE_AUDIO_DEFAUT,
      video: LIMITE_VIDEO_DEFAUT,
      source: "defaut",
    };
  }
}

/// Le plafond qui s'applique a une reunion donnee, d'apres son `type_media`.
///
/// Tout ce qui n'est pas explicitement la video est traite comme de l'audio :
/// une valeur inattendue doit retomber sur le plafond le PLUS PERMISSIF des
/// deux sans jamais autoriser des cameras au-dela du plafond video — or une
/// reunion dont le `type_media` n'est ni 1 ni 2 n'ouvre pas de camera.
export function limitePourTypeMedia(
  limites: LimitesReunion,
  typeMedia: number,
): number {
  return typeMedia === TYPE_MEDIA_VIDEO ? limites.video : limites.audio;
}

/// Places encore libres. Jamais negatif : une salle deja au-dela de son plafond
/// — plafond baisse alors que la reunion etait en cours — rend 0, pas un
/// nombre negatif qui donnerait des messages absurdes.
///
/// `occupants` compte les personnes DEJA dans la salle, ORGANISATEUR COMPRIS.
export function placesRestantes(limite: number, occupants: number): number {
  return Math.max(0, limite - occupants);
}

/// Le message de refus, ecrit une fois pour toutes.
///
/// Il dit TROIS choses, et les trois sont necessaires : ce qui est refuse, le
/// chiffre exact, et la raison. « Reunion pleine » seul laisse croire a une
/// panne ou a une restriction commerciale arbitraire ; savoir que la limite
/// tient a ce que chaque participant emet vers tous les autres rend le refus
/// comprehensible, et l'ecran suivant (basculer en audio, ou faire deux
/// reunions) evident.
///
/// Avec accents : c'est un texte montre a l'utilisateur, pas un commentaire.
export function messageSallePleine(typeMedia: number, limite: number): string {
  const media = typeMedia === TYPE_MEDIA_VIDEO ? "vidéo" : "audio";
  return (
    `Cette réunion ${media} est limitée à ${limite} participants, ` +
    `organisateur compris. Chaque participant envoie son flux à tous les ` +
    `autres : au-delà, la qualité s'effondre pour tout le monde.`
  );
}

/// Meme message, pour le refus AU MOMENT DE LA CREATION — ou l'on ne peut pas
/// dire « cette reunion », puisqu'elle n'existe pas encore.
export function messageCreationTropGrande(
  typeMedia: number,
  limite: number,
  demandes: number,
): string {
  const media = typeMedia === TYPE_MEDIA_VIDEO ? "vidéo" : "audio";
  return (
    `Une réunion ${media} accepte au maximum ${limite} participants, ` +
    `organisateur compris — vous en avez demandé ${demandes}. ` +
    `Chaque participant envoie son flux à tous les autres : au-delà, la ` +
    `qualité s'effondre pour tout le monde.`
  );
}
