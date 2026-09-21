import { prisma } from "@/lib/prisma";
import { nomAffichage } from "@/lib/display-name.mjs";

/**
 * LA SÉLECTION DES MÉDIAS À EXPORTER — une seule définition, deux usages.
 *
 * Le décompte affiché avant de lancer et la liste réellement archivée posent la
 * MÊME question. Deux requêtes écrites séparément se seraient désaccordées au
 * premier changement, et l'écran aurait annoncé « 312 fichiers » pour en livrer
 * 280 sans que rien ne l'explique.
 */

/** Les familles proposées à l'écran, et ce qu'elles recouvrent en base. */
export const FAMILLES = {
  photo: ["IMAGE"],
  video: ["VIDEO"],
  audio: ["AUDIO"],
  document: ["FILE"],
} as const;

export type Famille = keyof typeof FAMILLES;

export function estFamille(valeur: string): valeur is Famille {
  return Object.prototype.hasOwnProperty.call(FAMILLES, valeur);
}

export interface Criteres {
  /** Conversations retenues. Vide = toutes celles où je figure. */
  conversations: string[];
  familles: Famille[];
  du: Date | null;
  au: Date | null;
}

/**
 * La condition Prisma correspondant aux critères.
 *
 * 🔴 « REÇUS » SIGNIFIE `senderId != moi`, ET C'EST LA DEMANDE. On exporte ce
 * qu'on a reçu, pas ce qu'on a envoyé : ses propres fichiers, on les a déjà.
 *
 * ⚠️ LA CONDITION PORTE SUR LE MESSAGE, PAS SUR LE MÉDIA. `MediaFile.ownerId`
 * est le compte qui a TÉLÉVERSÉ le fichier, ce qui coïncide presque toujours
 * avec l'expéditeur — mais pas pour un média transféré, recréé au nom de celui
 * qui le fait suivre. C'est l'expéditeur du message qui dit si on l'a reçu.
 *
 * ⚠️ ET LES MESSAGES SUPPRIMÉS SONT ÉCARTÉS. Un média dont le message a été
 * effacé n'est plus visible dans la discussion : le retrouver dans une archive
 * serait le ressusciter par une porte de derrière.
 */
export function conditionMedias(userId: string, criteres: Criteres) {
  const types = criteres.familles.flatMap((f) => [...FAMILLES[f]]);
  const quand: { gte?: Date; lte?: Date } = {};
  if (criteres.du) quand.gte = criteres.du;
  if (criteres.au) quand.lte = criteres.au;

  return {
    // Un média orphelin — message supprimé, avatar, accueil de répondeur — n'a
    // rien à faire dans un export de discussions.
    message: {
      is: {
        senderId: { not: userId },
        deletedAt: null,
        type: { in: types as ("IMAGE" | "VIDEO" | "AUDIO" | "FILE")[] },
        ...(Object.keys(quand).length > 0 ? { createdAt: quand } : {}),
        conv: {
          // Le contrôle d'accès tient ICI, et il est indispensable : sans lui,
          // un identifiant de conversation glissé dans l'URL exporterait les
          // médias de gens qu'on ne connaît pas.
          participants: { some: { userId } },
          ...(criteres.conversations.length > 0
            ? { id: { in: criteres.conversations } }
            : {}),
        },
      },
    },
  };
}

/** Ce que l'écran annonce avant de lancer : combien, et quel poids. */
export async function chiffrerExport(userId: string, criteres: Criteres) {
  if (criteres.familles.length === 0) return { fichiers: 0, octets: 0 };
  const groupe = await prisma.mediaFile.aggregate({
    where: conditionMedias(userId, criteres),
    _count: { _all: true },
    _sum: { sizeBytes: true },
  });
  return { fichiers: groupe._count._all, octets: groupe._sum.sizeBytes ?? 0 };
}

/** Un média retenu, avec de quoi le nommer dans l'archive. */
export interface MediaExporte {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
  dossier: string;
}

/**
 * Les médias à archiver, page par page.
 *
 * 🔴 PAR PAGES DE CENT, ET JAMAIS D'UN COUP. Un export d'un an peut porter des
 * dizaines de milliers de lignes ; les charger toutes mettrait en mémoire ce
 * qu'on cherche justement à ne pas y mettre. Le curseur avance sur l'identifiant,
 * qui est unique et stable — un `skip` grandissant referait le même travail à
 * chaque page, et coûterait de plus en plus cher à mesure qu'on avance.
 */
export async function* mediasAExporter(
  userId: string,
  criteres: Criteres,
): AsyncGenerator<MediaExporte> {
  if (criteres.familles.length === 0) return;
  const where = conditionMedias(userId, criteres);
  const nomsDeConversation = new Map<string, string>();
  let apres: string | undefined;

  for (;;) {
    const page = await prisma.mediaFile.findMany({
      where,
      // Deux clés de tri : la date pour l'ordre lisible, l'identifiant pour
      // départager — sans lui, deux médias de la même milliseconde pourraient
      // se répéter d'une page à l'autre, ou se perdre entre les deux.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
      ...(apres ? { cursor: { id: apres }, skip: 1 } : {}),
      select: {
        id: true,
        url: true,
        filename: true,
        mimeType: true,
        sizeBytes: true,
        createdAt: true,
        message: {
          select: {
            convId: true,
            conv: {
              select: {
                name: true,
                isGroup: true,
                participants: {
                  select: {
                    userId: true,
                    user: { select: { nom: true, pseudo: true, publicNumber: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (page.length === 0) return;

    for (const media of page) {
      const conv = media.message?.conv;
      const convId = media.message?.convId ?? "";
      if (!nomsDeConversation.has(convId)) {
        nomsDeConversation.set(convId, nomDeDossier(conv, userId, convId));
      }
      yield {
        id: media.id,
        url: media.url,
        filename: media.filename,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes,
        createdAt: media.createdAt,
        dossier: nomsDeConversation.get(convId) as string,
      };
    }
    apres = page[page.length - 1].id;
  }
}

/**
 * Le nom du dossier d'une conversation, dans l'archive.
 *
 * ⚠️ EN TÊTE-À-TÊTE, C'EST LE NOM DE L'AUTRE. `conv.name` porte le titre d'un
 * GROUPE ; pour une conversation à deux il est vide, et un dossier « sans nom »
 * par correspondant rendrait l'archive illisible.
 */
function nomDeDossier(
  conv:
    | {
        name: string | null;
        isGroup: boolean;
        participants: Array<{
          userId: string;
          user: { nom: string | null; pseudo: string | null; publicNumber: string };
        }>;
      }
    | null
    | undefined,
  userId: string,
  convId: string,
): string {
  if (!conv) return assainir(convId.slice(0, 8));
  if (conv.isGroup && conv.name) return assainir(conv.name);
  const autre = conv.participants.find((p) => p.userId !== userId);
  const nom = autre ? nomAffichage(autre.user) : null;
  return assainir(nom || convId.slice(0, 8));
}

/**
 * Un fragment de nom que TOUS les systèmes de fichiers acceptent.
 *
 * 🔴 CE N'EST PAS DE LA COSMÉTIQUE. Un `/` dans un nom de discussion créerait un
 * sous-dossier imprévu ; un `:` ou un `?` rend l'archive impossible à extraire
 * sous Windows, et l'utilisateur voit « erreur inconnue » sans jamais
 * comprendre que c'est le nom d'un de ses contacts qui pose problème.
 *
 * ⚠️ LES NOMS RÉSERVÉS DE WINDOWS aussi : un dossier « CON » ou « NUL » refuse
 * de s'écrire, depuis MS-DOS et pour toujours.
 */
export function assainir(brut: string): string {
  const nettoye = brut
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Un point final disparaît silencieusement sous Windows : le nom change
    // sans prévenir, et deux dossiers peuvent alors se télescoper.
    .replace(/\.+$/, "")
    .slice(0, 60)
    .trim();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(nettoye)) return `_${nettoye}`;
  return nettoye || "sans-nom";
}
