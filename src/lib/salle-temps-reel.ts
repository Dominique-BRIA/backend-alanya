import http from "node:http";
// Le cote API du PONT INTERNE : d'ici, une route REST peut prevenir une salle
// de reunion ouverte.
//
// POURQUOI CE FICHIER EXISTE. L'API Next.js et le serveur temps reel
// (`ws-server.mjs`) sont DEUX PROCESSUS. Une route qui modifie une reunion ecrit
// en base et n'a aucun acces aux sockets : elles vivent dans l'autre process.
// Les participants deja dans la salle ne voyaient donc rien bouger et devaient
// sortir et revenir. La notification poussee ne comble pas ce trou : elle vise
// des APPAREILS par leur jeton, pas une salle, et ne reveille que les gens
// qu'on vient d'ajouter.
//
// L'autre bout est decrit en tete de la section « PONT INTERNE » de
// `ws-server.mjs`. Il ecoute sur 127.0.0.1 uniquement : l'API et le serveur
// temps reel doivent tourner sur le MEME hote.
//
// REGLE QUI TIENT TOUT LE RESTE : ces fonctions ne LEVENT JAMAIS. Le serveur
// temps reel arrete, le port change, le secret oublie — l'ajout du participant
// a deja ete ecrit en base, il est valide, et la route doit repondre son succes.
// On journalise, on rend `false`, on continue. Un pont casse degrade
// l'affichage ; il ne doit pas casser l'action.

/// PAR DEFAUT, UNE SOCKET DE FICHIER — rien a configurer, rien a faire fuiter.
///
/// Les deux processus vivent sur la meme machine : ils se parlent par un
/// fichier, et ce sont les permissions du systeme qui autorisent. Aucun port
/// n'est ouvert, aucun secret n'existe, donc aucun secret ne peut manquer ni
/// fuiter.
const SOCKET_PONT = process.env.WS_INTERNAL_SOCKET ?? "";

/// LE RESEAU, quand l'API et le serveur temps reel vivent sur deux machines.
///
/// La bascule ne se DEVINE pas — ce processus ne peut pas savoir ou tourne
/// l'autre. C'est la configuration qui la declare : poser cette URL, c'est dire
/// « l'ecouteur est ailleurs ». Le secret devient alors obligatoire des deux
/// cotes, et l'ecouteur d'en face refuse de demarrer sans lui.
const URL_PONT = (process.env.WS_INTERNAL_URL ?? "").replace(/\/+$/, "");
const SECRET_PONT = process.env.WS_INTERNAL_SECRET ?? "";
const PAR_RESEAU = URL_PONT !== "";

/// Le chemin de la socket, quand on n'est pas en reseau. Le meme defaut que
/// `ws-server.mjs`, et pour la meme raison : que le cas courant ne demande
/// AUCUNE variable.
/** Ce que les deux transports rendent en commun. */
interface ReponsePont {
  ok: boolean;
  status: number;
}

/** Par la socket de fichier — le cas courant, sans configuration ni secret. */
function viaSocket(corps: string): Promise<ReponsePont> {
  return new Promise((resoudre, rejeter) => {
    const requete = http.request(
      {
        socketPath: cheminSocket(),
        path: CHEMIN_PONT,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(corps),
        },
        timeout: DELAI_MS,
      },
      (rep) => {
        // Le corps est consomme meme si l'on n'en fait rien : une reponse
        // laissee en suspens garde sa connexion ouverte.
        rep.resume();
        rep.on("end", () =>
          resoudre({ ok: (rep.statusCode ?? 0) < 400, status: rep.statusCode ?? 0 }),
        );
      },
    );
    requete.on("timeout", () => requete.destroy(new Error("delai depasse")));
    requete.on("error", rejeter);
    requete.end(corps);
  });
}

/** Par le reseau — deux machines, et le secret devient obligatoire. */
async function viaReseau(corps: string): Promise<ReponsePont> {
  const rep = await fetch(`${URL_PONT}${CHEMIN_PONT}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [ENTETE_PONT]: SECRET_PONT,
    },
    body: corps,
    signal: AbortSignal.timeout(DELAI_MS),
    // Next.js instrumente `fetch` : une diffusion rejouee depuis un cache
    // n'aurait aucun sens.
    cache: "no-store",
  });
  await rep.text().catch(() => "");
  return { ok: rep.ok, status: rep.status };
}

function cheminSocket(): string {
  return SOCKET_PONT || `${process.cwd()}/.ws-interne.sock`;
}

const CHEMIN_PONT = "/interne/salle/diffuser";
const ENTETE_PONT = "x-alanya-interne";

/// Delai d'attente. C'est une requete vers un process de la MEME machine : elle
/// se compte en millisecondes ou elle ne reviendra pas. Cette borne existe pour
/// qu'un serveur temps reel vivant mais MUET — bloque, en train de mourir — ne
/// suspende pas derriere lui la requete HTTP d'un utilisateur. Un port ferme,
/// lui, refuse tout de suite et n'attend rien.
const DELAI_MS = 1500;

/**
 * MOTIFS de changement de composition d'une salle.
 *
 * Des CODES, jamais des phrases : le serveur ne rend aucun texte affichable, et
 * l'application parle neuf langues. C'est le client qui traduit.
 *
 * Le vocabulaire est declare ici, en un seul endroit, pour que le web et le
 * mobile parlent du meme evenement avec le meme mot.
 */
export type MotifSalle =
  | "PARTICIPANTS_ADDED"
  | "PARTICIPANT_REMOVED"
  | "ROLE_CHANGED";

/// Le verbe unique qui annonce qu'une composition de salle a change.
///
/// UN SEUL TYPE, ET UN MOTIF A L'INTERIEUR — plutot qu'un type par cas. Un
/// client qui ne connait pas encore `ROLE_CHANGED` relira quand meme la reunion
/// en le recevant ; avec un type inconnu, il aurait ignore le message et serait
/// reste sur un ecran perime. Ajouter un motif ne casse donc aucun client
/// deploye.
const VERBE_COMPOSITION = "meeting_participants_changed";

/// Le manque de configuration est signale UNE FOIS. Le repeter a chaque ajout
/// noierait le journal sous la meme ligne, et c'est au demarrage qu'il faut le
/// voir — `ws-server.mjs` le dit deja de son cote.
let manqueDejaSignale = false;

/**
 * Diffuse un verbe dans une salle de reunion.
 *
 * Rend `true` si l'ecouteur interne a accepte la diffusion. `false` couvre tout
 * le reste — pont non configure, process arrete, refus — et n'est JAMAIS une
 * raison de faire echouer l'appelant.
 *
 * ATTENTION A L'ORDRE : appeler cette fonction APRES l'ecriture en base, jamais
 * avant. L'evenement dit « votre copie est perimee, relisez » ; parti trop tot,
 * il enverrait tout le monde relire l'ancienne verite.
 *
 * Volontairement GENERALE : elle ignore ce que le verbe signifie. C'est ce qui
 * lui permet de servir l'exclusion et le changement de role sans changer.
 */
export async function previensLaSalle(params: {
  /// Identifiant de la reunion — la salle, cote serveur temps reel.
  meetingId: number;
  /// Verbe diffuse, de la forme `meeting_*`. L'ecouteur refuse le reste.
  type: string;
  /// Champs joints au message. Des codes et des identifiants, pas de texte
  /// affichable. `type` et `meetingId` sont poses par le serveur et ne peuvent
  /// pas etre ecrases d'ici.
  donnees?: Record<string, unknown>;
  /// Participant a ne pas servir — celui qui a provoque le changement, quand son
  /// propre client a deja la reponse de la route. A ne pas utiliser a la legere :
  /// exclure un utilisateur exclut TOUS ses appareils, y compris ceux qui n'ont
  /// rien demande.
  exclure?: string;
}): Promise<boolean> {
  const { meetingId, type, donnees, exclure } = params;

  if (!SECRET_PONT) {
    if (!manqueDejaSignale) {
      manqueDejaSignale = true;
      console.warn(
        "[salle] WS_INTERNAL_SECRET manquant : les salles ouvertes ne seront pas " +
          "prevenues des changements faits depuis l'API. Les actions restent valides.",
      );
    }
    return false;
  }

  try {
    const corps = JSON.stringify({ salle: meetingId, type, donnees, exclure });
    const reponse = PAR_RESEAU
      ? await viaReseau(corps)
      : // `fetch` ne sait PAS joindre une socket de fichier : il refuse le
        // schema `unix:` par « unknown scheme » — verifie a l'execution, la
        // forme `unix:/chemin:/route` est une convention de curl, pas de Node.
        // `http.request` avec `socketPath`, lui, le fait nativement.
        await viaSocket(corps);
    if (!reponse.ok) {
      console.error(
        `[salle] pont temps reel : HTTP ${reponse.status} pour ${type} (reunion ${meetingId})`,
      );
      return false;
    }
    return true;
  } catch (e) {
    // Serveur temps reel arrete, port ferme, delai depasse. L'action de
    // l'utilisateur est deja faite et le reste : on ne fait que perdre le
    // rafraichissement immediat des ecrans deja ouverts.
    const raison = e instanceof Error ? e.message : String(e);
    console.error(
      `[salle] pont temps reel injoignable pour ${type} (reunion ${meetingId}) : ${raison}`,
    );
    return false;
  }
}

/**
 * Annonce que la COMPOSITION d'une salle a change — ajout, exclusion, role.
 *
 * ON ENVOIE UN CODE, PAS LA LISTE, et c'est le coeur de la decision.
 *
 * Envoyer la liste complete eviterait un aller-retour, et c'est son seul
 * avantage. Ce qu'il coute :
 *
 *  - DEUX CLIENTS, DEUX FUSIONS. Le web et le mobile rangent les participants
 *    chacun dans sa propre representation. Une liste poussee doit etre fusionnee
 *    dans chacune, avec ses regles a elle — et deux fusions ecrites
 *    separement finissent par diverger sur les cas tordus.
 *  - L'ORDRE N'EST PAS GARANTI. Deux ajouts rapproches produisent deux listes ;
 *    celle qui arrive en dernier n'est pas forcement la plus recente, et le
 *    client afficherait durablement un etat perime. Un « ca a change » est
 *    idempotent : quel que soit l'ordre, la derniere relecture rapporte la
 *    verite.
 *  - UNE SECONDE SOURCE DE VERITE. La liste voyagerait alors par deux chemins,
 *    la route REST et la socket, qui devraient rester d'accord pour toujours.
 *
 * Le message ne porte donc que de quoi decider de relire : un motif, qui l'a
 * provoque, et combien de lignes bougent. Les clients rechargent la reunion par
 * `GET /api/meetings/:id` — la MEME source pour tout le monde.
 *
 * Le prix, assume : un aller-retour par client. Ces evenements sont rares — un
 * organisateur qui ajoute quelqu'un — sans commune mesure avec la signalisation
 * WebRTC qui traverse la meme salle en continu.
 */
export async function previensChangementParticipants(params: {
  meetingId: number;
  motif: MotifSalle;
  /// Qui a provoque le changement. Deja connu de toute la salle ; sert au client
  /// a formuler son avis sans avoir a le deviner.
  parUserId: string;
  /// Combien de participants sont concernes. Un nombre, pas une liste : de quoi
  /// afficher un avis tout de suite, rien a fusionner.
  nombre?: number;
}): Promise<boolean> {
  return previensLaSalle({
    meetingId: params.meetingId,
    type: VERBE_COMPOSITION,
    donnees: {
      motif: params.motif,
      parUserId: params.parUserId,
      ...(typeof params.nombre === "number" ? { nombre: params.nombre } : {}),
    },
  });
}
