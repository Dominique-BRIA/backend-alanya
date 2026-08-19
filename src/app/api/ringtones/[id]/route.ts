import { prisma } from "@/lib/prisma";
import { fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

/// Charge l'entree de catalogue SI elle appartient bien a l'appelant.
///
/// Le meme « introuvable » couvre la sonnerie inexistante et celle d'un autre
/// compte : un 403 distinct confirmerait au demandeur que l'identifiant existe.
async function sonneriePossedee(id: string, userId: string) {
  // Le proprietaire est dans le `where`, et non compare apres coup : la base ne
  // rend la ligne que si elle est bien celle de l'appelant, en une seule
  // requete. Le contrat l'exige a CHAQUE operation, et c'est la forme la plus
  // difficile a oublier — un filtre retire du `where` casse le test, un `if`
  // retire apres coup passe inapercu.
  return prisma.userRingtone.findFirst({
    where: { id, userId },
    select: { id: true },
  });
}

// DELETE /api/ringtones/:id — retire une sonnerie du catalogue.
export const DELETE = withAuth(async (_req, userId, ctx) => {
  const { id } = await ctx.params;

  if (!(await sonneriePossedee(id, userId))) {
    return fail("Sonnerie introuvable", 404, "NOT_FOUND");
  }

  // Seule l'ENTREE DE CATALOGUE part ; le media, lui, reste. Deux raisons. Il
  // peut etre encore attribue a une liste de contacts, qui n'en garde qu'une url
  // sans lien vers ici : l'effacer ferait taire la liste sans prevenir. Et sa
  // suppression est deja offerte par DELETE /api/media/:id, avec son propre
  // controle de proprietaire ; la redoubler ici donnerait deux chemins pour
  // effacer un fichier, dont un que l'utilisateur croit inoffensif.
  await prisma.userRingtone.delete({ where: { id } });

  // 204 sans corps, comme le contrat le prevoit : un corps sur un 204 serait
  // ignore par les clients.
  return new Response(null, { status: 204 });
});
