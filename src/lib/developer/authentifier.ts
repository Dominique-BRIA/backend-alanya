import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { fail } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { validateApiKey } from "./key-service";
import { CODE, STATUT_TROP_DE_REQUETES } from "./api-contract";

/**
 * LA PORTE D'ENTRÉE UNIQUE DES ROUTES `/api/v1/*`.
 *
 * Les cinq routes recopiaient les mêmes quinze lignes — extraction de l'en-tête,
 * validation de la clé, deux messages d'erreur — et **aucune** ne posait de
 * plafond de débit. Trois conséquences, toutes corrigées ici :
 *
 * 1. 🔴 **`RATE_LIMITED` était documenté dans le contrat gelé mais n'était émis
 *    par personne.** Un client qui suivait la documentation attendait un 429 qui
 *    ne pouvait pas arriver. Pire, rien ne limitait la cadence d'appel d'une
 *    clé : un défaut de boucle chez l'appelant vidait son solde, et une clé
 *    volée pouvait être exploitée à plein régime.
 *
 * 2. 🔴 **Seule `messages/send` alimentait la télémétrie.** `GET
 *    /api/developer/logs` — l'écran principal d'une console — ne montrait donc
 *    NI les vérifications, NI les médias, NI les appels. Un abonné dont tout le
 *    trafic est de la 2FA voyait un journal vide et en concluait que rien ne
 *    marchait. La journalisation est désormais posée par l'enrobage, donc elle
 *    ne peut plus être oubliée en ajoutant une route.
 *
 * 3. Le code de statut journalisé est lu sur la réponse RÉELLE, au lieu d'être
 *    recopié à la main à chaque sortie de fonction — quatre littéraux dans
 *    l'ancienne `messages/send`, dont un seul aurait suffi à mentir.
 *
 * ⚠️ LIMITE CONNUE, à dire au lieu de la laisser découvrir : `rate-limit.ts`
 * compte dans une `Map` en mémoire, donc **par processus**. Aujourd'hui le
 * backend est un seul `next start` et le compte est juste ; le jour où il passe
 * en grappe, ou pendant la bascule NestJS où deux processus servent les mêmes
 * routes, le plafond réel vaut le plafond × le nombre de processus. Ce n'est pas
 * une raison de ne pas le poser — un plafond doublé vaut infiniment mieux qu'un
 * plafond absent — mais il faudra un compteur partagé avant de s'en servir comme
 * d'une garantie de facturation.
 */

/** Plafond par IP, posé AVANT toute lecture de la base. */
const PLAFOND_PAR_IP_PAR_MINUTE = 120;

/** Ce qu'une route reçoit une fois l'appelant identifié. */
export interface CleAuthentifiee {
  /** `developer_accounts.developer_id` — la portée de TOUTES les données. */
  developerId: string;
  /** Le compte Alanya qui porte l'abonnement : l'expéditeur des messages. */
  userId: string;
  /** Douze premiers caractères, pour la télémétrie. Jamais la clé entière. */
  prefixe: string;
}

/*
 * 🔴 IL N'Y A PAS DE BAC À SABLE (décision du user, 21/08/2026).
 *
 * `ApiKeyType` distingue toujours `SANDBOX` de `LIVE` en base, mais **aucune
 * route n'en tient compte** : une clé est une clé, et toutes produisent des
 * effets réels. La distinction n'avait de sens que face à un développeur
 * extérieur qui essaie avant d'acheter ; l'appelant est ici la plateforme de
 * l'équipe, qui a ses propres environnements.
 *
 * ⚠️ La colonne `type` est LAISSÉE en base — elle est partagée avec le second
 * système qui écrit dans cette base, et retirer une valeur d'enum PostgreSQL
 * casserait ses lectures. Elle ne veut simplement plus rien dire de notre côté :
 * ne pas la réintroduire dans une décision d'exécution sans en reparler.
 */

/**
 * Applique le préambule commun, exécute le traitement, journalise.
 *
 * `plafondParMinute` est **par clé et par route** : une rafale d'envois ne doit
 * pas empêcher la 2FA du même abonné de passer. C'est la raison de la clé de
 * compteur composite.
 */
export async function routeV1(
  req: NextRequest,
  options: { chemin: string; plafondParMinute: number },
  traitement: (cle: CleAuthentifiee) => Promise<Response>,
): Promise<Response> {
  const debut = Date.now();
  const methode = req.method || "POST";

  /*
   * Plafond par IP d'abord. Il protège ce que le plafond par clé ne peut pas
   * protéger : les requêtes SANS clé valide, qui coûtent quand même un hachage
   * et une requête en base à chaque tentative. Sans lui, l'énumération de clés
   * est gratuite pour l'attaquant et payante pour nous.
   */
  const parIp = rateLimit(`v1:ip:${clientIp(req)}`, PLAFOND_PAR_IP_PAR_MINUTE, 60_000);
  if (!parIp.allowed) return tropDeRequetes(parIp.retryAfterSec);

  const entete = req.headers.get("Authorization") || "";
  const rawKey =
    entete.replace(/^Bearer\s+/i, "").trim() || (req.headers.get("X-Api-Key") || "").trim();

  if (!rawKey) {
    return fail(
      "Clé API manquante. En-tête X-Api-Key ou Authorization: Bearer ak_... requis.",
      401,
      CODE.CLE_MANQUANTE,
    );
  }

  const donnees = await validateApiKey(rawKey);
  if (!donnees || !donnees.developer) {
    return fail("Clé API invalide, révoquée ou introuvable.", 401, CODE.CLE_INVALIDE);
  }

  const cle: CleAuthentifiee = {
    developerId: donnees.developer.id,
    userId: donnees.developer.userId,
    prefixe: rawKey.slice(0, 12),
  };

  const parCle = rateLimit(
    `v1:cle:${donnees.id}:${options.chemin}`,
    options.plafondParMinute,
    60_000,
  );
  if (!parCle.allowed) {
    void journaliser(cle, options.chemin, methode, STATUT_TROP_DE_REQUETES, Date.now() - debut);
    return tropDeRequetes(parCle.retryAfterSec);
  }

  let reponse: Response;
  try {
    reponse = await traitement(cle);
  } catch (erreur) {
    console.error(`[v1 ${options.chemin}]`, erreur);
    reponse = fail("Erreur interne du serveur.", 500, CODE.ERREUR_INTERNE);
  }

  void journaliser(cle, options.chemin, methode, reponse.status, Date.now() - debut);
  return reponse;
}

/**
 * Le 429, avec son `Retry-After`.
 *
 * L'en-tête est ce qui distingue un refus exploitable d'un refus qui se devine :
 * sans lui, un client bien écrit ne peut que réessayer au hasard.
 *
 * ⚠️ Un refus AVANT identification n'est pas journalisé — `DeveloperApiLog`
 * exige un `developerId`, et nous n'en avons pas. C'est le seul trou de la
 * télémétrie, et il est volontaire : inventer un compte pour tracer un inconnu
 * salirait le journal de l'abonné.
 */
function tropDeRequetes(retryAfterSec: number): Response {
  const reponse = fail(
    "Trop de requêtes. Attendez avant de réessayer.",
    STATUT_TROP_DE_REQUETES,
    CODE.TROP_DE_REQUETES,
  );
  reponse.headers.set("Retry-After", String(Math.max(1, retryAfterSec)));
  return reponse;
}

/** Écrit une ligne de télémétrie. Un échec ici ne doit jamais casser l'appel. */
async function journaliser(
  cle: CleAuthentifiee,
  endpoint: string,
  method: string,
  statusCode: number,
  latencyMs: number,
): Promise<void> {
  try {
    await prisma.developerApiLog.create({
      data: {
        developerId: cle.developerId,
        keyPrefix: cle.prefixe,
        endpoint,
        method,
        statusCode,
        latencyMs,
      },
    });
  } catch {
    // Silencieux par conception : la télémétrie ne fait pas échouer un envoi.
  }
}
