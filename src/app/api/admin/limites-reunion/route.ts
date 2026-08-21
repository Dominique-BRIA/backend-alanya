import { type NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import {
  PLAFOND_MIN,
  PLAFOND_MAX_AUDIO,
  PLAFOND_MAX_VIDEO,
  LIMITE_AUDIO_DEFAUT,
  LIMITE_VIDEO_DEFAUT,
  limitesPourEntreprise,
} from "@/lib/limites-reunion";

// Administration des plafonds de participants — lecture et ecriture, pour
// l'application entiere ou pour une entreprise donnee.
//
// ┌───────────────────────────────────────────────────────────────────────┐
// │ COMMENT CES ROUTES SONT PROTEGEES, ET POURQUOI SI PAUVREMENT          │
// └───────────────────────────────────────────────────────────────────────┘
//
// CE QUI A ETE CHERCHE. Le modele `AdminRoot` (prisma/schema.prisma) porte un
// `username`, un `password` et un jeton de reinitialisation : tout ce qu'il
// faut a une session d'administration. Mais il n'est reference par AUCUN
// fichier de `src/` — verifie : pas une route, pas un controle de droit, pas
// une lecture. Idem pour `Root`. Ces tables existent en base et sont exploitees
// par une AUTRE application ; ce depot-ci n'a jamais su s'y connecter. Il
// n'existe donc aucun mecanisme de session de superuser a reutiliser.
//
// Le seul controle d'administration present ici est `ensureAdmin()`
// (src/lib/roles.ts), fonde sur `users.type_compte = 9`. Il ne convient PAS :
// c'est un pouvoir de MODERATION donne a des comptes utilisateurs ordinaires
// (exclure un compte), et le fichier dit lui-meme que la promotion se fait a la
// main en base faute de back-office. S'en servir pour regler un plafond
// reviendrait a confondre « moderateur » et « exploitant de la plateforme »,
// et a etendre silencieusement les pouvoirs de tous les moderateurs actuels.
//
// CE QUI A ETE CHOISI, ET CE QUE CELA VAUT. Un SECRET DE SERVEUR, lu dans
// l'environnement (`ALANYA_ADMIN_SECRET`) et presente dans l'en-tete
// `x-alanya-admin-secret`. C'est volontairement rustique. Ce que cela apporte :
// la route est inutilisable sans un secret que seul l'exploitant du serveur
// possede, il n'y a rien a inventer en base, et aucune faille de l'application
// utilisateur ne peut y donner acces. Ce que cela n'apporte PAS, et qu'il faut
// savoir avant de s'en servir :
//   - AUCUNE IDENTITE. Le secret dit « quelqu'un qui connait le secret », pas
//     QUI. C'est pourquoi `modifiePar` est OBLIGATOIRE a l'ecriture : la trace
//     est declarative, elle vaut ce que vaut l'honnetete de celui qui ecrit.
//   - AUCUNE REVOCATION individuelle : le secret est partage, le changer
//     coupe tout le monde.
//   - Un secret qui fuit (journal de proxy, historique de shell, capture) donne
//     tout, sans expiration.
//
// ⚠️ CE QUI RESTE A CONSTRUIRE : une vraie session d'administration — comptes
// nominatifs, mots de passe haches, jetons a duree de vie, journal des actions.
// Tant qu'elle n'existe pas, ces routes doivent rester HORS du reseau public si
// possible, et le secret doit etre traite comme une cle de production.
//
// POURQUOI PAS D'AUTHENTIFICATION BRICOLEE EN ATTENDANT. Poser ici une table de
// comptes administrateurs, un formulaire et un cookie aurait l'apparence d'une
// vraie authentification sans en avoir les garanties (pas de revocation, pas de
// second facteur, pas d'audit), et personne ne la remplacerait ensuite. Une
// protection visiblement provisoire vaut mieux qu'une protection faussement
// rassurante.

const EN_TETE_SECRET = "x-alanya-admin-secret";

/// Longueur minimale exigee du secret configure.
///
/// Un secret court est devinable, et cette route peut fermer toutes les
/// reunions de la plateforme. On refuse donc de DEMARRER avec un secret faible
/// plutot que de laisser croire qu'il protege quelque chose. 24 caracteres
/// aleatoires sont hors de portee d'une attaque en ligne, meme sans limitation
/// de debit — et il y en a une plus bas.
const LONGUEUR_MIN_SECRET = 24;

/// Comparaison a temps constant.
///
/// Un `===` sur des chaines s'arrete au premier caractere different : le temps
/// de reponse trahit alors la longueur du prefixe correct, et un attaquant
/// reconstruit le secret caractere par caractere. Les longueurs sont comparees
/// a part car `timingSafeEqual` exige des tampons de meme taille — la longueur
/// d'un secret n'est pas un renseignement exploitable.
function secretsEgaux(fourni: string, attendu: string): boolean {
  const a = Buffer.from(fourni, "utf8");
  const b = Buffer.from(attendu, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/// Garde d'acces. Rend `null` si l'appel est admis, sinon la reponse a
/// renvoyer telle quelle.
///
/// ECHOUE FERMEE : secret absent de l'environnement ou trop court, l'acces est
/// refuse. Une route d'administration qui s'ouvre parce qu'une variable manque
/// est pire que pas de route du tout — c'est exactement le cas ou personne ne
/// s'en apercoit.
function garde(req: NextRequest): Response | null {
  // La limitation de debit vient AVANT la comparaison : elle doit ralentir
  // celui qui essaie des secrets, pas seulement celui qui en a un bon.
  const ip = clientIp(req);
  const quota = rateLimit(`admin-limites:${ip}`, 20, 60_000);
  if (!quota.allowed) {
    return fail(
      `Trop de requêtes, réessayez dans ${quota.retryAfterSec} s`,
      429,
      "RATE_LIMITED",
    );
  }

  const attendu = process.env.ALANYA_ADMIN_SECRET ?? "";
  if (!attendu) {
    console.error(
      "[admin/limites-reunion] ALANYA_ADMIN_SECRET absent : route fermée",
    );
    return fail("Administration non configurée", 503, "ADMIN_NOT_CONFIGURED");
  }
  if (attendu.length < LONGUEUR_MIN_SECRET) {
    console.error(
      `[admin/limites-reunion] ALANYA_ADMIN_SECRET trop court (${attendu.length} < ${LONGUEUR_MIN_SECRET}) : route fermée`,
    );
    return fail("Administration non configurée", 503, "ADMIN_NOT_CONFIGURED");
  }

  const fourni = req.headers.get(EN_TETE_SECRET) ?? "";
  // Message identique dans les deux cas — en-tete absent ou faux : distinguer
  // les deux renseignerait sur ce qui est attendu.
  if (!fourni || !secretsEgaux(fourni, attendu)) {
    return fail("Accès refusé", 403, "FORBIDDEN");
  }

  return null;
}

/// Lit `?idCompany=` : absent = portee GLOBALE (null), sinon l'entreprise.
///
/// Rend `undefined` si le parametre est present mais illisible, pour que
/// l'appelant reponde 400 plutot que d'ecrire au hasard sur la portee globale —
/// une faute de frappe ne doit pas changer le plafond de toute l'application.
function porteeDepuisUrl(req: NextRequest): number | null | undefined {
  const brut = req.nextUrl.searchParams.get("idCompany");
  if (brut === null || brut.trim() === "") return null;
  const n = Number(brut);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

const SELECTION = {
  idLimite: true,
  idCompany: true,
  maxAudio: true,
  maxVideo: true,
  modifiePar: true,
  createdAt: true,
  updatedAt: true,
} as const;

type LigneBrute = {
  idLimite: number;
  idCompany: number | null;
  maxAudio: number;
  maxVideo: number;
  modifiePar: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function enJson(l: LigneBrute) {
  return {
    idLimite: l.idLimite,
    idCompany: l.idCompany,
    portee: l.idCompany === null ? "globale" : "entreprise",
    audio: l.maxAudio,
    video: l.maxVideo,
    modifiePar: l.modifiePar,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// GET /api/admin/limites-reunion            → la portee globale + la liste des
//                                             entreprises qui la surchargent
// GET /api/admin/limites-reunion?idCompany=12 → ce qui s'applique a cette
//                                             entreprise, et d'ou cela vient
// ---------------------------------------------------------------------------
//
// La lecture rend TOUJOURS `effectif` : le plafond reellement applique. Sans
// lui, une entreprise sans ligne propre apparaitrait sans plafond, ce qui est
// faux — elle suit la globale. C'est la question que se pose l'exploitant
// (« combien de personnes cette entreprise peut-elle reunir ? »), pas
// « existe-t-il une ligne en base ? ».
export async function GET(req: NextRequest) {
  const refus = garde(req);
  if (refus) return refus;

  try {
    const portee = porteeDepuisUrl(req);
    if (portee === undefined) {
      return fail("Paramètre idCompany invalide", 400, "BAD_REQUEST");
    }

    if (portee !== null) {
      const entreprise = await prisma.company.findUnique({
        where: { idCompany: portee },
        select: { idCompany: true, libelle: true },
      });
      if (!entreprise) return fail("Entreprise introuvable", 404, "NOT_FOUND");

      const ligne = await prisma.limiteReunion.findUnique({
        where: { idCompany: portee },
        select: SELECTION,
      });
      const effectif = await limitesPourEntreprise(portee);

      return ok({
        entreprise,
        // `null` = aucune surcharge posee ; l'entreprise suit la globale.
        ligne: ligne ? enJson(ligne) : null,
        effectif,
        bornes: bornes(),
      });
    }

    const lignes = await prisma.limiteReunion.findMany({
      select: { ...SELECTION, company: { select: { libelle: true } } },
      orderBy: [{ idCompany: "asc" }],
    });

    const globale = lignes.find((l) => l.idCompany === null);
    const entreprises = lignes
      .filter((l) => l.idCompany !== null)
      .map((l) => ({ ...enJson(l), libelle: l.company?.libelle ?? null }));

    return ok({
      // `null` si la ligne globale a ete supprimee a la main : le code retombe
      // alors sur ses defauts, que `effectif` montre.
      globale: globale ? enJson(globale) : null,
      entreprises,
      effectif: await limitesPourEntreprise(null),
      bornes: bornes(),
    });
  } catch (err) {
    return handleError(err);
  }
}

/// Les bornes ecrivables, renvoyees avec chaque lecture : l'interface
/// d'administration doit pouvoir borner ses champs sans recopier ces nombres,
/// et un operateur doit voir pourquoi 40 sera refuse avant de l'essayer.
function bornes() {
  return {
    min: PLAFOND_MIN,
    maxAudio: PLAFOND_MAX_AUDIO,
    maxVideo: PLAFOND_MAX_VIDEO,
    defautAudio: LIMITE_AUDIO_DEFAUT,
    defautVideo: LIMITE_VIDEO_DEFAUT,
  };
}

// ---------------------------------------------------------------------------
// PUT /api/admin/limites-reunion — pose ou remplace un plafond.
// ---------------------------------------------------------------------------
//
// Corps : { idCompany?: number|null, audio: number, video: number,
//           modifiePar: string }
//
// `idCompany` absent ou nul = on ecrit la portee GLOBALE.
//
// PUT et non PATCH : les deux valeurs sont fournies ensemble. Elles se lisent
// l'une par rapport a l'autre — un plafond video superieur au plafond audio se
// remarque quand on les voit cote a cote, beaucoup moins quand on les change
// separement a deux semaines d'intervalle.
const corpsSchema = z.object({
  idCompany: z.number().int().positive().nullable().optional(),
  audio: z
    .number({ invalid_type_error: "Le plafond audio doit être un nombre" })
    .int("Le plafond audio doit être un entier")
    .min(PLAFOND_MIN, `Le plafond audio ne peut pas descendre sous ${PLAFOND_MIN} : une réunion à une personne n'en est pas une`)
    .max(PLAFOND_MAX_AUDIO, `Le plafond audio ne peut pas dépasser ${PLAFOND_MAX_AUDIO} : chaque participant émet vers tous les autres, au-delà les appareils décrochent`),
  video: z
    .number({ invalid_type_error: "Le plafond vidéo doit être un nombre" })
    .int("Le plafond vidéo doit être un entier")
    .min(PLAFOND_MIN, `Le plafond vidéo ne peut pas descendre sous ${PLAFOND_MIN} : une réunion à une personne n'en est pas une`)
    .max(PLAFOND_MAX_VIDEO, `Le plafond vidéo ne peut pas dépasser ${PLAFOND_MAX_VIDEO} : chaque participant encode sa vidéo une fois par interlocuteur`),
  // OBLIGATOIRE. C'est la seule trace de QUI a change le plafond : le secret de
  // serveur, lui, n'identifie personne. Le rendre facultatif reviendrait a
  // n'avoir aucune trace des le premier appel presse.
  modifiePar: z
    .string()
    .trim()
    .min(2, "Indiquez qui effectue le changement")
    .max(120),
});

export async function PUT(req: NextRequest) {
  const refus = garde(req);
  if (refus) return refus;

  try {
    const corps = corpsSchema.parse(await req.json());
    const idCompany = corps.idCompany ?? null;

    const donnees = {
      maxAudio: corps.audio,
      maxVideo: corps.video,
      modifiePar: corps.modifiePar,
    };

    if (idCompany !== null) {
      // Verifie l'entreprise AVANT d'ecrire : sans cela la cle etrangere
      // echouerait en base et l'operateur recevrait une erreur illisible au
      // lieu de « entreprise introuvable ».
      const entreprise = await prisma.company.findUnique({
        where: { idCompany },
        select: { idCompany: true },
      });
      if (!entreprise) return fail("Entreprise introuvable", 404, "NOT_FOUND");

      const ligne = await prisma.limiteReunion.upsert({
        where: { idCompany },
        create: { idCompany, ...donnees },
        update: donnees,
        select: SELECTION,
      });
      return ok({ ligne: enJson(ligne), bornes: bornes() });
    }

    // Portee globale : pas d'`upsert` possible. La cle unique de Prisma est
    // `idCompany`, et une valeur NULLE ne peut pas servir de cible a un
    // `where` unique — c'est la meme raison qui oblige l'index partiel en base.
    const existante = await prisma.limiteReunion.findFirst({
      where: { idCompany: null },
      select: { idLimite: true },
    });

    const ligne = existante
      ? await prisma.limiteReunion.update({
          where: { idLimite: existante.idLimite },
          data: donnees,
          select: SELECTION,
        })
      : await prisma.limiteReunion.create({
          data: { idCompany: null, ...donnees },
          select: SELECTION,
        });

    return ok({ ligne: enJson(ligne), bornes: bornes() });
  } catch (err) {
    // Deux appels simultanes trouvant tous deux la ligne globale absente
    // tenteraient de la creer : l'index partiel refuse le second. Le cas est
    // improbable — c'est une route d'administration — et le remede evident.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return fail(
        "Un autre changement vient d'aboutir sur cette portée, réessayez",
        409,
        "CONFLICT",
      );
    }
    return handleError(err);
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/limites-reunion?idCompany=12 — retire la surcharge d'une
// entreprise, qui repasse sous le plafond global.
// ---------------------------------------------------------------------------
//
// C'est la seule facon d'ANNULER un reglage d'entreprise. Sans elle, une
// entreprise reglee une fois resterait figee sur son chiffre : baisser le
// plafond general ne l'atteindrait plus, et personne ne saurait pourquoi.
//
// La ligne GLOBALE, elle, ne se supprime pas. Le code retomberait certes sur
// ses defauts, mais l'ecran d'administration n'afficherait plus aucun plafond
// modifiable, et la seule facon d'en reposer un serait d'en connaitre
// l'existence. On la remplace, on ne l'efface pas.
export async function DELETE(req: NextRequest) {
  const refus = garde(req);
  if (refus) return refus;

  try {
    const portee = porteeDepuisUrl(req);
    if (portee === undefined) {
      return fail("Paramètre idCompany invalide", 400, "BAD_REQUEST");
    }
    if (portee === null) {
      return fail(
        "Le plafond global ne se supprime pas : modifiez-le avec PUT",
        400,
        "BAD_REQUEST",
      );
    }

    const ligne = await prisma.limiteReunion.findUnique({
      where: { idCompany: portee },
      select: { idLimite: true },
    });
    // Deja absent : l'entreprise suit deja la globale, c'est-a-dire l'etat
    // demande. On le dit sans en faire une erreur.
    if (!ligne) {
      return ok({
        message: "Aucun plafond propre à cette entreprise",
        effectif: await limitesPourEntreprise(portee),
      });
    }

    await prisma.limiteReunion.delete({ where: { idLimite: ligne.idLimite } });

    return ok({
      message: "Plafond de l'entreprise retiré ; elle suit désormais le plafond global",
      effectif: await limitesPourEntreprise(portee),
    });
  } catch (err) {
    return handleError(err);
  }
}
