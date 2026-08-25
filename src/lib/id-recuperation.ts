import crypto from "crypto";
import { prisma } from "./prisma";

/**
 * IDENTIFIANT DE RÉCUPÉRATION — le seul moyen de reprendre un compte ouvert
 * SANS adresse électronique.
 *
 * 🔴 C'EST UN SECRET, au même titre qu'un mot de passe : le présenter suffit à
 * réinitialiser le mot de passe du compte. Trois conséquences, toutes tenues
 * ici ou dans `POST /api/auth/reset-password` :
 *
 *   1. il est tiré au sort par `crypto`, jamais dérivé de quoi que ce soit qui
 *      concerne le compte (ni le numéro Alanya, ni la date, ni le pseudo) —
 *      sinon le deviner reviendrait à connaître le titulaire ;
 *   2. il n'est montré QU'UNE FOIS, à la création, et le client doit le dire ;
 *   3. les tentatives sont plafonnées à la réinitialisation, sans quoi les
 *      2^50 combinaisons ci-dessous ne protégeraient de rien.
 */

/**
 * Alphabet de Crockford : les 10 chiffres et 22 lettres, **sans I, L, O ni U**.
 *
 * ⚠️ CE N'EST PAS DE LA COQUETTERIE. Cet identifiant est fait pour être RECOPIÉ
 * À LA MAIN, souvent depuis une capture d'écran vers un bout de papier, puis
 * ressaisi des mois plus tard. Les paires `1`/`I`/`l` et `0`/`O` sont la
 * première cause d'échec de ce genre de code ; les retirer de l'alphabet rend
 * la confusion IMPOSSIBLE plutôt que rattrapable.
 *
 * `U` est écarté pour une autre raison, celle de Crockford : son absence évite
 * qu'un tirage produise un mot grossier, qu'un utilisateur nous montrerait.
 *
 * 32 symboles sur 10 positions = 2^50 combinaisons, soit ~1,1 million de
 * milliards. Un attaquant limité à quelques essais par minute n'en approche
 * jamais ; c'est le plafond de tentatives qui rend ce chiffre réel.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Longueur exacte — c'est aussi celle de la colonne `users.idRecuperation`. */
export const LONGUEUR_ID_RECUPERATION = 10;

/**
 * Met une saisie sous la forme exacte que porte la base.
 *
 * ⚠️ TOUJOURS l'appeler avant de chercher en base : la colonne contient
 * l'identifiant en majuscules et sans séparateur, et une recherche sur la
 * saisie brute échouerait sur une minuscule ou un tiret que l'utilisateur a
 * cru bien faire d'ajouter.
 *
 * Les trois substitutions ne sont pas de la tolérance gratuite : `I`, `L` et
 * `O` ne peuvent PAS appartenir à un identifiant émis (ils ne sont pas dans
 * l'alphabet), donc les rencontrer ne peut vouloir dire qu'une chose — la
 * personne a lu un `1` ou un `0`. Traduire est ici sans ambiguïté, alors que
 * refuser renverrait « identifiant inconnu » à quelqu'un qui a le bon.
 */
export function normaliserIdRecuperation(saisie: string): string {
  return saisie
    .toUpperCase()
    // Espaces, tirets, points : tout ce qu'on ajoute pour se relire.
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/** Un tirage, sans garantie d'unicité. */
function tirage(): string {
  const octets = crypto.randomBytes(LONGUEUR_ID_RECUPERATION);
  let sortie = "";
  for (let i = 0; i < LONGUEUR_ID_RECUPERATION; i++) {
    /*
     * ⚠️ `% 32` et non `% ALPHABET.length` posé au hasard : 256 est un multiple
     * exact de 32, donc le reste est UNIFORME. Avec un alphabet dont la taille
     * ne divise pas 256, ce calcul favoriserait les premiers symboles — un
     * biais invisible qui réduirait l'entropie réelle sans que rien ne le
     * signale. Si l'alphabet change un jour, ce calcul doit changer avec lui.
     */
    sortie += ALPHABET[octets[i] % ALPHABET.length];
  }
  return sortie;
}

/**
 * Un identifiant de récupération libre.
 *
 * Même forme que `generateUniquePublicNumber` : on retire un tirage plutôt que
 * de laisser la contrainte d'unicité échouer à l'insertion, ce qui rendrait
 * l'erreur illisible pour l'appelant.
 */
export async function genererIdRecuperationUnique(maxTentatives = 12): Promise<string> {
  for (let i = 0; i < maxTentatives; i++) {
    const candidat = tirage();
    const existant = await prisma.user.findUnique({
      where: { idRecuperation: candidat },
      select: { id: true },
    });
    if (!existant) return candidat;
  }
  // Injoignable en pratique (2^50 combinaisons pour quelques dizaines de
  // comptes) : si cela arrive, c'est que `crypto` ne tire plus au sort, et
  // continuer émettrait des identifiants prévisibles.
  throw new Error("Impossible de générer un identifiant de récupération unique.");
}
