import { type NextRequest } from "next/server";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { limitesPour } from "@/lib/limites-reunion";

// GET /api/meetings/limits — les deux plafonds qui s'appliqueront a une reunion
// que CE compte cree : son entreprise, sinon le reglage global, sinon les
// defauts. C'est `limitesPour` qui tranche cette precedence, et elle seule.
//
// A QUOI CETTE ROUTE SERT, ET A QUOI ELLE NE SERT PAS.
//
// Elle sert a PREVENIR AVANT LE GESTE. Sans elle, un client ne peut apprendre
// le plafond qu'en se le prenant : on choisit huit personnes, on clique, on est
// refuse. Le refus reste juste, mais il arrive trop tard pour eviter le
// travail perdu — et il n'aide pas a choisir entre retirer quelqu'un et
// basculer en audio, puisqu'il ne dit rien du plafond de l'autre mode.
//
// Elle ne DECIDE rien. Le serveur reste seul juge au moment de la creation, et
// c'est indispensable : le reglage peut changer entre l'ouverture du formulaire
// et l'envoi, et un plafond tenu par un client n'est pas un plafond. On donne
// donc au client les NOMBRES, jamais la regle qui les produit.
//
// ELLE NE REND QUE LES DEUX PLAFONDS. Ni la source (« entreprise » / « globale »
// / « defaut »), ni les bornes ecrivables, ni l'identifiant de la ligne : ce
// sont des informations d'exploitation, elles vivent dans
// /api/admin/limites-reunion derriere le secret de serveur. Un participant n'a
// pas a savoir si son entreprise a paye un plafond plus haut que celle d'en
// face ; il a besoin de savoir combien de personnes il peut reunir.
//
// C'est une lecture de REGLAGE, jamais un etat de reunion : aucune reunion
// n'est nommee ici, aucun occupant n'est compte. Les places d'une reunion
// precise sont dans GET /api/meetings/:id, qui, lui, sait de quelle reunion on
// parle et qui l'organise.
//
// Authentifiee comme le reste des reunions : le plafond depend de l'entreprise
// de l'appelant, il n'y a donc pas de reponse possible sans savoir qui appelle.
//
// ⚠️ Segment statique devant `[id]` : Next.js fait passer `limits` avant la
// route dynamique voisine, cette adresse ne sera donc jamais lue comme une
// reunion d'identifiant « limits ».
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const { audio, video } = await limitesPour(userId);
  return ok({ audio, video });
});
