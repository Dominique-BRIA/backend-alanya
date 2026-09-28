/**
 * LE CLAIR ET LES FILS CHIFFRÉS — les portes LATÉRALES.
 *
 * 🔴 L'ENVOI ÉTAIT GARDÉ, LE RESTE NON. Depuis le 22/09, un fil chiffré refuse
 * le texte en clair à l'envoi, en REST comme en WebSocket. Mais deux autres
 * gestes écrivent du texte dans un fil sans passer par l'envoi :
 *
 *   · MODIFIER un message : le nouveau texte partait en clair, s'écrivait dans
 *     `message.content`, remontait dans l'aperçu de la liste et était diffusé
 *     aux participants. Le mobile proposait « Modifier » sur une bulle chiffrée.
 *   · TRANSFÉRER : le serveur recopie `content`. Depuis un fil chiffré, il
 *     n'a rien — il fabriquait une bulle vide. VERS un fil chiffré, il
 *     écrivait du clair là où tout doit être chiffré.
 *
 * Prouvé par `scripts/e2ee-clair-banc.mjs` le 28/09/2026 : 11 fuites.
 *
 * ⚠️ FICHIER `.mjs`, SANS AUCUN IMPORT : `ws-server.mjs` et les routes Next le
 * partagent, et une règle écrite deux fois finit toujours par diverger — la
 * leçon des trois oublis du répondeur. Sans import, elle s'exécute aussi
 * seule, contre des valeurs choisies.
 */

/** Le motif de refus, tel que les clients le reconnaissent déjà à l'envoi. */
export const CONVERSATION_CHIFFREE = "CONVERSATION_CHIFFREE";

/** Le serveur n'a pas le texte de ce message : il ne peut pas le recopier. */
export const SOURCE_CHIFFREE = "SOURCE_CHIFFREE";

function aDuTexte(contenu) {
  return typeof contenu === "string" && contenu.trim() !== "";
}

/**
 * Peut-on modifier un message de ce fil ?
 *
 * ⚠️ TOUT FIL CHIFFRÉ EST REFUSÉ, même pour un ancien message écrit en clair
 * avant l'activation : le nouveau texte, lui, serait écrit APRÈS, et en clair.
 * Modifier un message chiffré demanderait de rechiffrer — un chantier à part.
 */
export function refusModification({ filChiffre }) {
  return filChiffre ? CONVERSATION_CHIFFREE : null;
}

/**
 * Peut-on transférer ce message vers ce fil ?
 *
 * ⚠️ DEUX REFUS DISTINCTS, et l'ordre compte :
 *   1. le serveur n'a pas le texte (message chiffré) → rien à recopier ;
 *   2. la cible est chiffrée et il y a du texte → il y entrerait en clair.
 *
 * ⚠️ UN MÉDIA SANS LÉGENDE PASSE, dans les deux sens : les pièces jointes ne
 * sont pas chiffrées (chantier remis), et l'envoi les laisse déjà passer.
 * Refuser ici ce que l'envoi accepte serait incohérent.
 */
export function refusTransfert({ sourceChiffree, cibleChiffree, type, contenu }) {
  if (sourceChiffree && type === "TEXT" && !aDuTexte(contenu)) return SOURCE_CHIFFREE;
  if (cibleChiffree && aDuTexte(contenu)) return CONVERSATION_CHIFFREE;
  return null;
}
