import { type NextRequest } from "next/server";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { fournisseursDisponibles } from "@/lib/traduction-fournisseurs";

/**
 * GET /api/translate/providers — les moteurs proposables, et leur prix.
 *
 * POURQUOI CETTE ROUTE. Les Parametres affichent une liste de moteurs avec un
 * prix devant chacun. Deux choses ne peuvent pas etre ecrites en dur dans le
 * web :
 *  - la DISPONIBILITE. Une option dont la cle manque cote serveur echouerait au
 *    premier message traduit. Le web ne peut pas le savoir seul : il demande.
 *  - le PRIX. Les tarifs des fournisseurs bougent. Les figer dans le client
 *    obligerait a redeployer le web pour corriger un chiffre — et un prix faux
 *    affiche a l'utilisateur est pire qu'un prix absent.
 *
 * Aucun libelle n'est renvoye, volontairement : le web possede son catalogue
 * i18n et traduit les noms lui-meme a partir de l'identifiant. Le serveur ne
 * possede que ce que le web ne peut pas savoir.
 *
 * Le moteur du navigateur figure dans la liste bien qu'il ne soit jamais servi
 * ici : les Parametres tiennent ainsi leur liste entiere d'une seule source.
 * C'est `surAppareil` qui le distingue, et c'est au client de verifier que le
 * navigateur possede reellement le moteur — cette sonde-la ne peut se faire
 * que sur l'appareil.
 *
 * Sous authentification : la liste decrit la configuration de l'infrastructure,
 * qui n'a aucune raison d'etre publique.
 *
 * Les variables d'environnement sont documentees en tete de
 * `@/lib/traduction-fournisseurs`.
 */

/** Reponse :
 * {
 *   defaut: "navigateur",
 *   fournisseurs: [
 *     { id, surAppareil, gratuit, prixParMillion, devise } ...  // du - cher au + cher
 *   ]
 * }
 */
export const GET = withAuth(async (_req: NextRequest, _userId: string) => {
  return ok({
    /**
     * Le moteur du navigateur reste le defaut : gratuit ET rien ne sort de
     * l'appareil. C'est le seul choix qui gagne sur les deux tableaux ; les
     * autres sont des replis pour qui n'a pas ce moteur. Le serveur l'annonce
     * pour que la regle ne soit pas re-decidee dans le client.
     */
    defaut: "navigateur",
    fournisseurs: fournisseursDisponibles(),
  });
});
