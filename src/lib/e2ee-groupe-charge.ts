/**
 * LA CHARGE D'UN MESSAGE DE GROUPE CHIFFRÉ, vue du serveur (lot 2c, cours
 * chapitre 32).
 *
 * Le client envoie `{ chiffre: true, groupe: { version, corps, appareil } }` :
 *
 *   · `corps`    : base64( 0x01 | nonce 12 | chiffré + étiquette 16 | signature 64 ) ;
 *   · `version`  : la version de la clé du groupe utilisée ;
 *   · `appareil` : l'identifiant Signal de l'appareil qui a chiffré et signé.
 *
 * 🔴 LE SERVEUR NE VÉRIFIE NI LA SIGNATURE NI LE CHIFFRÉ, et ne le pourrait
 * pas : il n'a pas la clé. Il contrôle la FORME (pour ne pas ranger n'importe
 * quoi), la VERSION (pour que personne n'écrive avec une clé qu'un exclu
 * connaît encore) et l'APPAREIL (qu'il ait une identité publiée, sans quoi les
 * membres ne pourraient pas vérifier la signature). C'est le destinataire qui
 * vérifie la signature, avec une clé d'identité qu'il connaît DÉJÀ.
 */

/** Plafond du corps, en caractères base64 — le même que la contrainte SQL. */
export const CORPS_GROUPE_MAX = 90_000;

/** Octet de format, nonce, étiquette GCM, signature XEdDSA. */
const TAILLE_MIN = 1 + 12 + 16 + 64;

/** Le premier octet du corps : le format v1 (`FORMAT_GROUPE` côté clients). */
const FORMAT_GROUPE = 0x01;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type ChargeGroupe = { version: number; corps: string; appareil: number };

/**
 * L'identifiant d'un message de groupe, TIRÉ PAR L'APPAREIL.
 *
 * 🔴 POURQUOI LE CLIENT LE CHOISIT (09/10/2026, lot 4). La signature et les
 * données associées du chiffré contiennent l'identifiant du message (cours,
 * chapitre 32) : il doit donc exister AVANT le chiffrement. En tête-à-tête, on
 * créait la ligne puis on déposait les enveloppes ; en groupe, le chiffré
 * voyage AVEC la ligne, en un seul envoi. L'appareil tire un UUID v4 ; le
 * serveur vérifie sa forme et qu'il est libre.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function idMessageClient(brut: unknown): string | null {
  return typeof brut === "string" && UUID.test(brut) ? brut : null;
}

const entierPositif = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1;

/**
 * Lit la charge `groupe` d'une requête. Rend `null` si elle est mal formée.
 *
 * ⚠️ `undefined` quand elle est ABSENTE, `null` quand elle est INVALIDE : les
 * deux cas n'appellent pas la même réponse (un ancien client n'en envoie pas,
 * un client défectueux en envoie une fausse).
 */
export function lireChargeGroupe(brut: unknown): ChargeGroupe | null | undefined {
  if (brut === undefined || brut === null) return undefined;
  if (typeof brut !== "object") return null;
  const g = brut as Record<string, unknown>;
  if (!entierPositif(g.version) || !entierPositif(g.appareil)) return null;
  if (typeof g.corps !== "string" || g.corps.length > CORPS_GROUPE_MAX) return null;
  if (g.corps.length % 4 !== 0 || !BASE64.test(g.corps)) return null;
  const octets = Buffer.from(g.corps, "base64");
  if (octets.length < TAILLE_MIN || octets[0] !== FORMAT_GROUPE) return null;
  return { version: g.version, corps: g.corps, appareil: g.appareil };
}
