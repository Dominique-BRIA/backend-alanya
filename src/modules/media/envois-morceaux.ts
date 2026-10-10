import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";
import { requireUser } from "@/lib/auth-context";
import {
  ASSEMBLAGE_BLOQUE_MS,
  ENVOIS_EN_COURS_MAX,
  INACTIVITE_MAX_MS,
  debutDuMorceau,
  morceauxManquants,
  nombreDeMorceaux,
  tailleDuMorceau,
  tailleMorceauConfiguree,
} from "@/lib/envoi-morceaux.mjs";
import { enregistrerMedia, type MediaCree } from "./creation";
import { publierSiProgramme } from "./publication-differee";
import type { EnvoiMorceaux } from "@prisma/client";

// =============================================================================
// L'ENVOI DE FICHIERS EN MORCEAUX, CÔTÉ SERVEUR (10/10/2026).
// =============================================================================
//
// Le parcours :
//   1. RÉSERVER (`POST /api/media/envois`, jeton d'accès) : le serveur crée la
//      ligne, prépare le fichier sur disque et rend un JETON D'ENVOI ;
//   2. ENVOYER chaque morceau (`PUT|POST …/morceaux/:n`, jeton d'envoi), dans
//      n'importe quel ordre, plusieurs à la fois, autant de fois que nécessaire ;
//   3. le morceau qui COMPLÈTE le fichier déclenche l'ASSEMBLAGE : le fichier
//      devient un média ordinaire, et sa réponse le rend.
//
// 🔴 LE DERNIER MORCEAU TERMINE L'ENVOI, SANS AUTRE APPEL DU CLIENT. C'est ce
// qui permet à Android de finir l'envoi application fermée : il n'a que des
// morceaux à pousser, aucune étape finale qui demanderait le code Dart.
//
// 🔴 LE JETON D'ENVOI, ET PAS LE JETON D'ACCÈS. Le jeton d'accès dure 15
// minutes ; Android envoie les morceaux pendant des heures s'il le faut, sans
// que l'application tourne pour le renouveler. Le jeton d'envoi n'ouvre QUE
// cet envoi, et dure autant que lui.
// =============================================================================

export const ENTETE_JETON = "x-envoi-jeton";

export function tailleMorceau(): number {
  return tailleMorceauConfiguree(env.media.tailleMorceauKo);
}

function dossierEnvois(): string {
  return path.isAbsolute(env.media.envoisDir)
    ? env.media.envoisDir
    : // Sans ce commentaire, Turbopack croit qu'on lit tout le projet et le trace
      // en entier dans le build (« Encountered unexpected file in NFT list »).
      path.join(/*turbopackIgnore: true*/ process.cwd(), env.media.envoisDir);
}

function cheminTampon(id: string): string {
  return path.join(dossierEnvois(), `${id}.bin`);
}

function empreinteJeton(jeton: string): string {
  return crypto.createHash("sha256").update(jeton).digest("hex");
}

// -----------------------------------------------------------------------------
// Qui a le droit de toucher à un envoi.
// -----------------------------------------------------------------------------

/**
 * L'envoi désigné, à condition que la requête porte SON jeton d'envoi.
 *
 * ⚠️ UN ENVOI INCONNU ET UN JETON FAUX RÉPONDENT PAREIL (404) : dire « il
 * existe, mais ce n'est pas le bon jeton » apprendrait à un curieux quels
 * identifiants sont en cours.
 */
export async function envoiParJeton(req: NextRequest, id: string): Promise<EnvoiMorceaux> {
  const jeton = req.headers.get(ENTETE_JETON) ?? "";
  const envoi = /^[0-9a-f-]{36}$/i.test(id)
    ? await prisma.envoiMorceaux.findUnique({ where: { id } })
    : null;
  if (!envoi || !jeton) throw new HttpError(404, "Envoi inconnu", "ENVOI_INCONNU");
  const attendu = Buffer.from(envoi.jetonHash, "hex");
  const recu = Buffer.from(empreinteJeton(jeton), "hex");
  if (attendu.length !== recu.length || !crypto.timingSafeEqual(attendu, recu)) {
    throw new HttpError(404, "Envoi inconnu", "ENVOI_INCONNU");
  }
  return envoi;
}

/**
 * Le jeton d'envoi OU le jeton d'accès de son propriétaire. Pour lire l'état
 * et abandonner : l'application ouverte a l'un, Android a l'autre.
 */
export async function envoiParJetonOuProprietaire(
  req: NextRequest,
  id: string,
): Promise<EnvoiMorceaux> {
  if (req.headers.get(ENTETE_JETON)) return envoiParJeton(req, id);
  return envoiDuProprietaire(id, requireUser(req).sub);
}

/** L'envoi, s'il appartient à ce compte ; 404 sinon (même réponse que « inconnu »). */
export async function envoiDuProprietaire(id: string, userId: string): Promise<EnvoiMorceaux> {
  const envoi = /^[0-9a-f-]{36}$/i.test(id)
    ? await prisma.envoiMorceaux.findUnique({ where: { id } })
    : null;
  if (!envoi || envoi.ownerId !== userId) throw new HttpError(404, "Envoi inconnu", "ENVOI_INCONNU");
  return envoi;
}

// -----------------------------------------------------------------------------
// 1. Réserver.
// -----------------------------------------------------------------------------

export interface DemandeEnvoi {
  taille: number;
  nom: string;
  mime: string;
  chiffre: boolean;
  dureeMs: number | null;
  empreinte: string | null;
}

export async function reserverEnvoi(ownerId: string, demande: DemandeEnvoi) {
  // Le ménage se fait ici, à l'occasion, plutôt que par une tâche planifiée de
  // plus à surveiller : chaque nouvel envoi efface ceux qu'on a abandonnés.
  await purgerEnvoisExpires().catch((err) =>
    console.error("[envois] purge des envois expirés :", err),
  );

  const enCours = await prisma.envoiMorceaux.count({
    where: { ownerId, statut: { not: "termine" } },
  });
  if (enCours >= ENVOIS_EN_COURS_MAX) {
    throw new HttpError(429, "Trop d'envois en cours", "TROP_D_ENVOIS");
  }

  /*
   * ⚠️ LA PLACE EST VÉRIFIÉE À LA RÉSERVATION, pas au fil des morceaux : un
   * disque plein découvert au 200ᵉ morceau aurait fait attendre l'utilisateur
   * pour rien. Une marge d'1 Gio reste pour la base et les journaux.
   */
  await fs.mkdir(dossierEnvois(), { recursive: true });
  const disque = await fs.statfs(dossierEnvois());
  if (disque.bavail * disque.bsize < demande.taille + 1024 ** 3) {
    throw new HttpError(507, "Espace disque insuffisant sur le serveur", "STOCKAGE_PLEIN");
  }

  const taille = tailleMorceau();
  const jeton = crypto.randomBytes(32).toString("base64url");
  const envoi = await prisma.envoiMorceaux.create({
    data: {
      ownerId,
      jetonHash: empreinteJeton(jeton),
      taille: demande.taille,
      tailleMorceau: taille,
      nbMorceaux: nombreDeMorceaux(demande.taille, taille),
      nom: demande.nom.slice(0, 255),
      mime: demande.mime,
      chiffre: demande.chiffre,
      dureeMs: demande.dureeMs,
      empreinte: demande.empreinte,
    },
  });

  // Le fichier existe dès maintenant, à sa taille finale : chaque morceau
  // s'écrit à sa place, quel que soit l'ordre d'arrivée.
  const fichier = await fs.open(cheminTampon(envoi.id), "w");
  try {
    await fichier.truncate(demande.taille);
  } finally {
    await fichier.close();
  }

  return {
    id: envoi.id,
    /*
     * L'identifiant que portera le média une fois assemblé — celui de l'envoi.
     * Connu dès maintenant, il peut entrer dans le descripteur chiffré et les
     * enveloppes que l'appareil prépare pour la publication différée.
     */
    mediaId: envoi.id,
    jeton,
    tailleMorceau: envoi.tailleMorceau,
    nbMorceaux: envoi.nbMorceaux,
    expireApresJours: Math.round(INACTIVITE_MAX_MS / (24 * 60 * 60 * 1000)),
  };
}

// -----------------------------------------------------------------------------
// 2. Recevoir un morceau.
// -----------------------------------------------------------------------------

/**
 * Écrit le morceau `indice` à sa place, puis le marque reçu.
 *
 * 🔴 MARQUÉ REÇU SEULEMENT S'IL EST ARRIVÉ EN ENTIER. Une connexion coupée en
 * route livre un corps plus court : on n'en dit rien en base, et le client le
 * renverra. Les octets déjà écrits seront simplement réécrits.
 */
export async function recevoirMorceau(
  envoi: EnvoiMorceaux,
  indice: number,
  corps: ReadableStream<Uint8Array> | null,
) {
  if (envoi.statut === "termine") {
    // Un morceau rejoué après la fin (réponse perdue en route) : on redit le
    // résultat au lieu de refuser — c'est ce que le client attendait.
    return { ...(await etatEnvoi(envoi)), termine: true };
  }

  const attendu = tailleDuMorceau(indice, envoi.taille, envoi.tailleMorceau);
  if (attendu === null) throw new HttpError(404, "Morceau inexistant", "MORCEAU_INCONNU");
  if (!corps) throw new HttpError(400, "Morceau vide", "MORCEAU_INCOMPLET");

  const fichier = await fs.open(cheminTampon(envoi.id), "r+").catch(() => {
    // Le tampon a disparu (purge, disque nettoyé à la main) : l'envoi ne peut
    // plus aboutir, le client doit en réserver un autre.
    throw new HttpError(410, "Envoi expiré", "ENVOI_EXPIRE");
  });
  let ecrits = 0;
  try {
    let position = debutDuMorceau(indice, envoi.tailleMorceau);
    for await (const bout of corps as unknown as AsyncIterable<Uint8Array>) {
      if (ecrits + bout.length > attendu) {
        throw new HttpError(413, "Morceau plus long que prévu", "MORCEAU_TROP_LONG");
      }
      await fichier.write(bout, 0, bout.length, position);
      position += bout.length;
      ecrits += bout.length;
    }
  } finally {
    await fichier.close();
  }
  if (ecrits !== attendu) {
    throw new HttpError(400, `Morceau incomplet (${ecrits}/${attendu} octets)`, "MORCEAU_INCOMPLET");
  }

  await prisma.$transaction([
    prisma.envoiMorceauRecu.createMany({
      data: [{ envoiId: envoi.id, indice }],
      skipDuplicates: true,
    }),
    prisma.envoiMorceaux.update({ where: { id: envoi.id }, data: { majLe: new Date() } }),
  ]);

  const recus = await prisma.envoiMorceauRecu.count({ where: { envoiId: envoi.id } });
  if (recus < envoi.nbMorceaux) {
    return { recus, total: envoi.nbMorceaux, termine: false };
  }
  await assembler(envoi.id);
  // Relu après l'assemblage : il rend le média et, s'il y en avait une, la
  // publication du message. Si un autre morceau assemble au même instant,
  // `termine` reste faux ici et l'appareil relira l'état.
  const apres = await prisma.envoiMorceaux.findUniqueOrThrow({ where: { id: envoi.id } });
  return { ...(await etatEnvoi(apres)), termine: apres.statut === "termine" };
}

// -----------------------------------------------------------------------------
// 3. Assembler.
// -----------------------------------------------------------------------------

/**
 * Transforme le fichier reconstitué en média. `null` si un autre morceau,
 * arrivé au même instant, s'en charge déjà.
 *
 * 🔴 UN SEUL ASSEMBLAGE, MÊME SI DEUX MORCEAUX FINISSENT ENSEMBLE. Avec trois
 * morceaux en vol, les deux derniers peuvent compter « tout est là » à la
 * même milliseconde. Le passage `en_cours → assemblage` se fait par une
 * écriture CONDITIONNELLE : la base n'en laisse passer qu'une.
 */
export async function assembler(id: string): Promise<MediaCree | null> {
  const bloque = new Date(Date.now() - ASSEMBLAGE_BLOQUE_MS);
  const pris = await prisma.envoiMorceaux.updateMany({
    where: {
      id,
      OR: [{ statut: "en_cours" }, { statut: "assemblage", majLe: { lt: bloque } }],
    },
    data: { statut: "assemblage", majLe: new Date() },
  });
  if (pris.count === 0) return null;

  const envoi = await prisma.envoiMorceaux.findUniqueOrThrow({ where: { id } });
  const remettre = () =>
    prisma.envoiMorceaux.update({ where: { id }, data: { statut: "en_cours", majLe: new Date() } });

  try {
    const recus = await prisma.envoiMorceauRecu.findMany({
      where: { envoiId: id },
      select: { indice: true },
    });
    if (morceauxManquants(recus.map((r) => r.indice), envoi.nbMorceaux).length > 0) {
      await remettre();
      return null;
    }

    /*
     * ⚠️ LU EN MÉMOIRE, comme le fait `POST /api/media` depuis toujours (250 Mo
     * au plus, sur un serveur qui en a 23 Go). C'est volontaire : on reprend le
     * chemin de rangement déjà éprouvé vers R2, au lieu d'en ouvrir un second
     * en flux qu'on n'aurait pas pu essayer contre R2 avant la production.
     */
    const buffer = await fs.readFile(cheminTampon(id));
    if (buffer.length !== envoi.taille) {
      await remettre();
      throw new HttpError(500, "Fichier reconstitué de mauvaise taille", "ASSEMBLAGE_INCOHERENT");
    }

    /*
     * 🔴 EMPREINTE FAUSSE : ON REPART DE ZÉRO. On ne sait pas QUEL morceau
     * s'est abîmé, seulement que le tout ne correspond pas. Tous les morceaux
     * redeviennent « manquants » : le client les renverra, et ce qui était
     * juste sera réécrit à l'identique.
     */
    if (envoi.empreinte) {
      const calculee = crypto.createHash("sha256").update(buffer).digest("hex");
      if (calculee !== envoi.empreinte) {
        await prisma.$transaction([
          prisma.envoiMorceauRecu.deleteMany({ where: { envoiId: id } }),
          prisma.envoiMorceaux.update({
            where: { id },
            data: { statut: "en_cours", majLe: new Date() },
          }),
        ]);
        throw new HttpError(422, "Le fichier reçu ne correspond pas à son empreinte", "EMPREINTE_FAUSSE");
      }
    }

    // Toujours le seau PRIVÉ : l'accueil de répondeur et la sonnerie, seuls
    // usages publics, sont de petits fichiers qui passent par `POST /api/media`.
    const media = await enregistrerMedia({
      id: envoi.id,
      ownerId: envoi.ownerId,
      buffer,
      nom: envoi.nom,
      mime: envoi.mime,
      chiffre: envoi.chiffre,
      espace: "prive",
      durationMs: envoi.dureeMs,
    });

    await prisma.envoiMorceaux.update({
      where: { id },
      data: { statut: "termine", mediaId: media.id, majLe: new Date() },
    });
    await fs.rm(cheminTampon(id), { force: true });

    // Le message préparé par l'appareil, s'il y en a un. Ne lève jamais.
    await publierSiProgramme(id);
    return media;
  } catch (err) {
    const statut = await prisma.envoiMorceaux.findUnique({ where: { id }, select: { statut: true } });
    if (statut?.statut === "assemblage") await remettre();
    throw err;
  }
}

// -----------------------------------------------------------------------------
// État, abandon, ménage.
// -----------------------------------------------------------------------------

/**
 * Où en est l'envoi : c'est ce que relit un appareil après une coupure ou un
 * redémarrage, pour ne renvoyer QUE ce qui manque.
 */
export async function etatEnvoi(envoi: EnvoiMorceaux) {
  const recus = await prisma.envoiMorceauRecu.findMany({
    where: { envoiId: envoi.id },
    select: { indice: true },
  });
  const media = envoi.mediaId
    ? await prisma.mediaFile.findUnique({ where: { id: envoi.mediaId } })
    : null;
  return {
    id: envoi.id,
    statut: envoi.statut,
    total: envoi.nbMorceaux,
    recus: recus.length,
    tailleMorceau: envoi.tailleMorceau,
    manquants: morceauxManquants(recus.map((r) => r.indice), envoi.nbMorceaux),
    // La publication différée : null (aucune), attente, en_cours, publie, refus:<MOTIF>.
    publication: { etat: envoi.publicationEtat, messageId: envoi.messageId },
    ...(media
      ? {
          media: {
            id: media.id,
            url: `/api/media/${media.id}`,
            mimeType: media.mimeType,
            sizeBytes: media.sizeBytes,
            durationMs: media.durationMs,
          } satisfies MediaCree,
        }
      : {}),
  };
}

/** L'utilisateur renonce : la ligne et le fichier partiel disparaissent. */
export async function abandonnerEnvoi(envoi: EnvoiMorceaux): Promise<void> {
  await prisma.envoiMorceaux.delete({ where: { id: envoi.id } }).catch(() => {});
  await fs.rm(cheminTampon(envoi.id), { force: true });
}

/**
 * Efface les envois restés sans nouvelles depuis 7 jours.
 *
 * ⚠️ LES ENVOIS TERMINÉS AUSSI, au même délai : leur média vit sa vie dans
 * `media_files`, la ligne d'envoi ne sert plus qu'à redire le résultat à un
 * client dont la dernière réponse s'est perdue.
 */
export async function purgerEnvoisExpires(): Promise<number> {
  const limite = new Date(Date.now() - INACTIVITE_MAX_MS);
  const perimes = await prisma.envoiMorceaux.findMany({
    where: { majLe: { lt: limite } },
    select: { id: true },
    take: 100,
  });
  for (const { id } of perimes) {
    await prisma.envoiMorceaux.delete({ where: { id } }).catch(() => {});
    await fs.rm(cheminTampon(id), { force: true });
  }
  return perimes.length;
}
