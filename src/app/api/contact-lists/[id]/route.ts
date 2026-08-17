import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { updateContactListSchema } from "@/lib/validation";
import {
  AVEC_MEMBRES,
  estDoublonUnique,
  jsonListe,
  membresResolus,
  repertoireDe,
  reponseNomDejaPris,
} from "@/lib/contact-lists";

/// Charge la liste SI elle appartient bien a l'appelant.
///
/// Le meme « introuvable » couvre la liste inexistante et celle d'un autre
/// compte : un 403 distinct confirmerait au demandeur que l'identifiant existe.
async function listePossedee(id: string, userId: string) {
  const list = await prisma.contactList.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  return list && list.userId === userId ? list : null;
}

// PUT /api/contact-lists/:id — met a jour une liste. Les champs absents restent
// inchanges ; `memberIds` ou `memberNumbers` fourni REMPLACE l'ensemble des
// membres par l'union des deux.
export const PUT = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;
  const data = updateContactListSchema.parse(await req.json());

  if (!(await listePossedee(id, userId))) {
    return fail("Liste introuvable", 404, "NOT_FOUND");
  }

  // Le renommage se heurte a l'unicite par compte, mais pas a la liste elle-meme :
  // reenvoyer son nom actuel doit rester une operation valide.
  if (data.name !== undefined) {
    const homonyme = await prisma.contactList.findFirst({
      where: { userId, name: data.name, id: { not: id } },
      select: { id: true },
    });
    if (homonyme) return reponseNomDejaPris();
  }

  // L'un OU l'autre des deux champs suffit a declencher le remplacement : ce sont
  // deux facons de designer les membres du MEME ensemble, pas deux ensembles.
  // N'envoyer que `memberNumbers` doit donc bien vider les membres venus
  // d'identifiants, sinon l'appel ne serait plus idempotent.
  const remplaceMembres =
    data.memberIds !== undefined || data.memberNumbers !== undefined;

  const { ids, unknownNumbers } = await membresResolus(
    userId,
    data.memberIds,
    data.memberNumbers,
  );

  try {
    const list = await prisma.$transaction(async (tx) => {
      // Remplacement et non ajout : l'appel doit pouvoir etre rejoue sans
      // gonfler la liste. Purge puis reinsertion dans la meme transaction, sinon
      // un echec au milieu laisserait la liste vide.
      if (remplaceMembres) {
        await tx.contactListMember.deleteMany({ where: { listId: id } });
        if (ids.length > 0) {
          await tx.contactListMember.createMany({
            data: ids.map((memberId) => ({ listId: id, memberId })),
          });
        }
      }

      return tx.contactList.update({
        where: { id },
        data: {
          name: data.name,
          ringtone: data.ringtone,
          color: data.color,
        },
        include: AVEC_MEMBRES,
      });
    });

    // Sur les membres tels que la base les porte apres ecriture, et non sur `ids` :
    // quand aucun des deux champs n'est fourni, les membres sont ceux d'avant.
    const repertoire = await repertoireDe(userId, list.members.map((m) => m.memberId));

    return ok({ list: jsonListe(list, repertoire), unknownNumbers });
  } catch (err) {
    if (estDoublonUnique(err)) return reponseNomDejaPris();
    throw err;
  }
});

// DELETE /api/contact-lists/:id — supprime une liste et ses appartenances.
export const DELETE = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;

  if (!(await listePossedee(id, userId))) {
    return fail("Liste introuvable", 404, "NOT_FOUND");
  }

  // Les lignes de `contactListMember` partent avec, par la cle etrangere en
  // cascade : rien a purger ici.
  await prisma.contactList.delete({ where: { id } });

  // 204 sans corps, et non `ok({ message })` : le contrat le prevoit ainsi, et un
  // corps sur un 204 serait ignore par les clients.
  return new Response(null, { status: 204 });
});
