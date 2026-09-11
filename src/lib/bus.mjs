import Redis from "ioredis";
import { PREFIXE } from "./redis-client.mjs";

/**
 * LE BUS : un processus annonce, les autres écoutent.
 *
 * POURQUOI CE MODULE. Jusqu'ici, un processus qui apprenait quelque chose ne
 * pouvait le dire qu'à ceux qui tenaient ses propres sockets. Le pont interne
 * (`salle-temps-reel.ts`) contournait le problème pour un cas précis — prévenir
 * une salle de réunion depuis l'API — mais par une socket de FICHIER, ce qui
 * impose que les deux processus vivent sur la même machine et qu'il n'y ait
 * qu'un seul serveur temps réel. Le bus n'a pas ces limites.
 *
 * ⚠️ CE N'EST PAS UN REMPLACEMENT DU PONT, et surtout pas encore. Le pont
 * fonctionne, il est éprouvé, et il sert un chemin critique. Ce module démarre
 * sur un besoin plus modeste et sans risque : accélérer l'attribution d'un
 * agent à quelqu'un qui patiente dans une file.
 *
 * ⚠️ UNE CONNEXION DÉDIÉE, ET C'EST OBLIGATOIRE. Redis interdit à un client
 * abonné d'exécuter autre chose que des commandes d'abonnement : réutiliser le
 * client du cache casserait toutes ses lectures dès le premier `subscribe`.
 * D'où deux connexions ici, ouvertes seulement si l'on s'abonne ou si l'on
 * publie vraiment.
 *
 * ⚠️ UN MESSAGE PUBLIÉ N'EST PAS CONSERVÉ. Personne n'écoute, il est perdu, et
 * c'est la bonne sémantique pour ce qu'on transporte : « un agent vient de se
 * libérer » n'a de sens que maintenant. Rien de ce qui passe par ce bus ne doit
 * être la seule trace d'un fait — la base reste la vérité, le bus ne fait que
 * l'annoncer plus tôt.
 */

const URL_REDIS = process.env.REDIS_URL ?? "";

/** Les canaux. Déclarés ici pour qu'aucun nom ne soit écrit deux fois. */
export const canaux = {
  /// Un agent d'un centre vient de se libérer. Les files qui l'attendaient
  /// peuvent tenter une attribution sans attendre leur prochain tour de boucle.
  agentLibre: (centreId) => `${PREFIXE}bus:agent-libre:${centreId}`,
};

let editeur = null;
let lecteur = null;
let pannePubliee = false;
let panneAbonnee = false;

/** Options communes. Le bus ne doit jamais retarder ce qu'il accompagne. */
function options() {
  return {
    // Une reconnexion qui s'espace, pour ne pas marteler un Redis qui redémarre.
    retryStrategy: (tentative) => Math.min(tentative * 200, 5000),
    // ⚠️ `maxRetriesPerRequest: 1` : une publication qui n'aboutit pas doit
    // échouer vite. Elle n'est qu'une accélération — la boucle de secours fera
    // le travail quelques secondes plus tard.
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  };
}

/**
 * Annonce un fait à qui écoute. Ne lève jamais, et n'attend presque rien.
 *
 * ⚠️ L'APPELANT NE DOIT PAS DÉPENDRE DU RÉSULTAT. Rend `false` quand rien n'a
 * été publié — Redis absent, coupé, saturé — et c'est un cas ordinaire, pas une
 * erreur à traiter. Tout ce que le bus transporte doit avoir un chemin de
 * secours qui fonctionne sans lui.
 */
export async function publier(canal, donnees) {
  if (!URL_REDIS) return false;
  try {
    if (!editeur) editeur = new Redis(URL_REDIS, options());
    await editeur.publish(canal, JSON.stringify(donnees ?? {}));
    return true;
  } catch (e) {
    if (!pannePubliee) {
      pannePubliee = true;
      console.warn(`[bus] publication impossible (signalé une fois) : ${e?.message ?? e}`);
    }
    return false;
  }
}

/**
 * Écoute un canal.
 *
 * ⚠️ LE RAPPEL NE DOIT JAMAIS LEVER : il s'exécute hors de toute requête, et une
 * exception non rattrapée ici abattrait le processus. On l'enveloppe donc, et
 * une erreur du rappel est journalisée sans conséquence.
 *
 * Rend une fonction qui arrête l'écoute — à appeler quand ce qu'on attendait
 * n'a plus lieu d'être, sans quoi les abonnements s'accumuleraient à chaque
 * appel entrant.
 */
export function abonner(canal, rappel) {
  if (!URL_REDIS) return () => {};

  try {
    if (!lecteur) {
      lecteur = new Redis(URL_REDIS, options());
      lecteur.on("error", (e) => {
        if (!panneAbonnee) {
          panneAbonnee = true;
          console.warn(`[bus] abonnement en panne (signalé une fois) : ${e?.message ?? e}`);
        }
      });
    }

    const surMessage = (canalRecu, charge) => {
      if (canalRecu !== canal) return;
      try {
        rappel(charge ? JSON.parse(charge) : {});
      } catch (e) {
        console.error(`[bus] rappel de ${canal} : ${e?.message ?? e}`);
      }
    };

    lecteur.subscribe(canal).catch(() => {});
    lecteur.on("message", surMessage);

    return () => {
      try {
        lecteur?.off("message", surMessage);
        // ⚠️ On ne se DÉSABONNE PAS du canal : plusieurs appelants peuvent
        // écouter le même centre en même temps, et couper l'abonnement priverait
        // les autres. Retirer notre écouteur suffit ; le canal sans écouteur ne
        // coûte rien.
      } catch {
        // Rien à faire : le processus s'arrête, ou la connexion est déjà tombée.
      }
    };
  } catch (e) {
    console.warn(`[bus] abonnement impossible : ${e?.message ?? e}`);
    return () => {};
  }
}

/** Ferme les connexions du bus. Appelé à l'arrêt du processus. */
export async function fermerBus() {
  const aFermer = [editeur, lecteur].filter(Boolean);
  editeur = null;
  lecteur = null;
  await Promise.all(
    aFermer.map((c) =>
      c
        .quit()
        .catch(() => c.disconnect())
        .catch(() => {}),
    ),
  );
}
