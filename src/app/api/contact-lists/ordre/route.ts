import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { ordreContactListsSchema } from "@/lib/validation";
import { jsonListe, listesDe, repertoireDe } from "@/lib/contact-lists";

/**
 * PUT /api/contact-lists/ordre — l'ordre de priorite des listes du compte.
 *
 * 🔴 CE QUE CET ORDRE DECIDE. Une meme personne peut figurer dans plusieurs
 * listes qui ne portent pas la meme sonnerie ; il faut bien en choisir une. La
 * regle etait « la plus anciennement creee gagne » : stable, mais le choix de
 * personne — on ne pouvait la changer qu'en supprimant puis recreant une liste,
 * et l'ordre obtenu ne s'expliquait pas a l'ecran. Cette route rend l'arbitrage
 * a l'utilisateur.
 *
 * ⚠️ UNE ROUTE A ELLE, ET NON UN CHAMP DE PLUS DANS LE PATCH D'UNE LISTE.
 * Reordonner n'est pas modifier une liste : c'est modifier LEUR RELATION, et
 * cela touche toutes les lignes a la fois. Passer par le PATCH aurait oblige le
 * client a envoyer quatre requetes pour un seul geste, avec un ordre incoherent
 * entre la premiere et la derniere — et deux glissements rapides auraient pu
 * s'entrelacer.
 */
export const PUT = withAuth(async (req: NextRequest, userId: string) => {
  const { ids } = ordreContactListsSchema.parse(await req.json());

  /*
   * TOUTES LES LISTES DU COMPTE DOIVENT ETRE CITEES, exactement une fois.
   *
   * Accepter un sous-ensemble obligerait a inventer une regle pour les absentes
   * — les mettre devant ? derriere ? garder leur rang ? — et chacune serait
   * arbitraire. Exiger l'ensemble complet rend l'intention du client explicite
   * et l'ecriture totale : apres cet appel, plus AUCUNE liste n'a un `ordre`
   * nul, et l'arbitrage cesse d'etre implicite.
   *
   * ⚠️ ON RELIT LES LISTES PLUTOT QUE DE CROIRE LE CLIENT : entre le moment ou
   * il a affiche l'ecran et celui ou il glisse une ligne, une liste a pu etre
   * creee sur son autre appareil. Le refus est alors la bonne reponse — le
   * client relit et reaffiche, plutot que d'ecrire un ordre qui ignore la
   * nouvelle venue.
   */
  const existantes = await prisma.contactList.findMany({
    where: { userId },
    select: { id: true },
  });

  const connues = new Set(existantes.map((l) => l.id));
  const demandes = new Set(ids);

  if (demandes.size !== ids.length) {
    return fail("Une liste est citee deux fois", 422, "ORDRE_DOUBLON");
  }
  if (demandes.size !== connues.size || ids.some((id) => !connues.has(id))) {
    return fail(
      "L'ordre doit citer toutes les listes du compte, exactement une fois",
      422,
      "ORDRE_INCOMPLET",
    );
  }

  /*
   * ⚠️ EN UNE SEULE TRANSACTION, et c'est indispensable.
   *
   * Reordonner quatre listes, c'est quatre ecritures. Interrompues a mi-chemin
   * — connexion perdue, processus relance — elles laisseraient deux listes au
   * nouveau rang et deux a l'ancien : un ordre que l'utilisateur n'a jamais
   * demande, et dont il ne comprendrait pas d'ou il sort.
   *
   * Aucune contrainte d'unicite n'est posee sur (userId, ordre), volontairement :
   * pendant que les rangs se croisent, deux listes portent brievement le meme
   * numero. Une contrainte ferait echouer l'ecriture des la deuxieme ligne.
   */
  await prisma.$transaction(
    ids.map((id, rang) =>
      prisma.contactList.update({
        // `userId` dans le filtre en plus de `id` : sans lui, un identifiant
        // devine reordonnerait la liste de quelqu'un d'autre. `updateMany`
        // n'est pas utilise ici parce qu'on veut l'echec si la ligne a disparu
        // entre la verification et l'ecriture.
        where: { id, userId },
        data: { ordre: rang },
      }),
    ),
  );

  // On rend les listes dans leur nouvel ordre plutot qu'un simple accuse : le
  // client reaffiche alors ce que le SERVEUR a retenu, et non ce qu'il croit
  // avoir envoye. Les deux divergent des qu'un appel se croise avec un autre.
  const listes = await listesDe(userId);
  const repertoire = await repertoireDe(
    userId,
    listes.flatMap((l) => l.members.map((m) => m.memberId)),
  );
  return ok({ lists: listes.map((l) => jsonListe(l, repertoire)) });
});
