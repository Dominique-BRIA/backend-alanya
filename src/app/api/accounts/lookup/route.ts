import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { rateLimit } from "@/lib/rate-limit";
import { publicNumberSchema } from "@/lib/validation";
import { comptesParNumerosPublics } from "@/lib/publicNumber";
import { membreAffichable, repertoireDe } from "@/lib/contact-lists";

/**
 * GET /api/accounts/lookup?number=<chiffres> — le NOM derriere un numero.
 *
 *   200 { found: true, account: { id, publicNumber, name, isContact } }
 *   200 { found: false }
 *
 * A quoi elle sert. Quand on compose un numero dans les listes de contacts, le
 * client n'a que des chiffres a l'ecran. Il lui faut le nom du titulaire du
 * compte, et le meme que celui deja affiche dans les listes — d'ou le passage
 * par `membreAffichable`, qui est exactement la regle de nommage de
 * `jsonListe` : alias du repertoire d'abord, nom public du compte ensuite,
 * `null` si le compte n'a ni nom ni pseudo (le client montre alors le numero).
 *
 * CE QU'ELLE OUVRE — la question a se poser, puisqu'elle rend un NOM a partir
 * d'un NUMERO :
 *
 *   - POST /api/contacts rend deja ce nom pour le meme numero (`user.pseudo`,
 *     via `nomAffichage`), et distingue deja par son code de retour le numero
 *     inconnu (404) du numero qui existe (201 / 409). Il faut toutefois ECRIRE
 *     pour l'obtenir : le compte entre au repertoire au passage.
 *   - GET /api/users/search?number= rend deja STRICTEMENT PLUS, et en lecture
 *     seule : le nom, l'avatar, le message de statut et `alreadyContact`, pour
 *     un simple compte authentifie, sans limitation de debit.
 *
 * Cette route n'ouvre donc RIEN de nouveau : elle rend un sous-ensemble de ce
 * que `/api/users/search` donne deja au meme appelant. Elle existe pour la forme
 * de sa reponse — `found: false` plutot qu'un 404, et le nom du REPERTOIRE de
 * l'appelant, que `/api/users/search` ne regarde pas — et non pour un acces
 * nouveau. Si l'enumeration des numeros doit etre fermee, c'est
 * `/api/users/search` qu'il faut traiter d'abord, sans quoi fermer celle-ci ne
 * ferme rien.
 *
 * CE QU'ELLE NE DIT PAS. Uniquement les quatre champs du contrat : pas d'avatar,
 * pas de message de statut, pas d'e-mail, pas de date de creation ni de derniere
 * connexion. Ajouter un champ ici, c'est elargir ce qu'un numero seul permet
 * d'apprendre — a peser a ce moment-la, pas par habitude.
 *
 * SON PROPRE NUMERO rend `found: false` : on ne se cherche pas soi-meme. La
 * reponse est alors indistinguable d'un numero inconnu, et c'est voulu.
 *
 * DEBIT. Le plafond reprend `rateLimit` (src/lib/rate-limit.ts), deja en place
 * sur les routes d'authentification (par IP) et sur POST /api/geo (par compte) ;
 * rien n'a ete invente ici. Il est pose par COMPTE parce que la route est
 * authentifiee : c'est le compte qui repond de ses appels, pas l'adresse IP, que
 * le mobile change en changeant de reseau. Ce compteur vit EN MEMOIRE et par
 * instance, comme le dit son fichier : il borne un client deregle, il n'arrete
 * pas un balayage determine reparti sur plusieurs instances. La vraie garde
 * reste que le numero doit etre connu pour etre demande.
 */

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

export const GET = withAuth(async (req: NextRequest, userId: string) => {
  // Large a dessein — un utilisateur qui compose corrige, efface et recompose —
  // mais borne : sans plafond, la route se prete a un balayage des numeros.
  const rl = rateLimit(`lookup:${userId}`, 60, 60_000);
  if (!rl.allowed) {
    return fail("Trop de recherches de numéro, réessayez dans un instant", 429, "RATE_LIMITED");
  }

  // La FORME acceptee du numero est tenue par `publicNumberSchema`, et nulle
  // part ailleurs : un numero composable dans une liste doit etre cherchable
  // ici, et une seconde regle ecrite a la main finirait par refuser ce que le
  // reste de l'API accepte. Le message vient du schema pour la meme raison.
  const parsed = publicNumberSchema.safeParse(req.nextUrl.searchParams.get("number") ?? "");
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Numéro invalide", 422, "BAD_NUMBER");
  }
  const numero = parsed.data;

  // Meme resolution « numero -> compte » que POST /api/contacts et que les
  // listes de contacts, et non une troisieme ecriture de la meme chose : voir
  // `comptesParNumerosPublics`.
  const comptes = await comptesParNumerosPublics([numero]);
  const cible = comptes.get(numero);
  if (!cible) return ok({ found: false });

  // Comparaison en minuscules par prudence, comme dans `membresResolus` : les
  // identifiants viennent de la base, mais `userId` a fait le detour du jeton.
  if (cible.toLowerCase() === userId.toLowerCase()) return ok({ found: false });

  // Second acces au compte plutot qu'un `select` elargi dans la resolution
  // partagee : celle-ci rend des identifiants, et lui faire porter des champs
  // d'affichage la chargerait pour tous ses appelants, dont aucun autre n'en a
  // besoin.
  const compte = await prisma.user.findUnique({
    where: { id: cible },
    select: { id: true, publicNumber: true, nom: true, pseudo: true },
  });
  if (!compte) return ok({ found: false });

  // Une seule lecture du repertoire donne les deux champs : sa VALEUR est
  // l'alias local, sa PRESENCE vaut `isContact`.
  const repertoire = await repertoireDe(userId, [compte.id]);

  return ok({ found: true, account: membreAffichable(compte, repertoire) });
});
