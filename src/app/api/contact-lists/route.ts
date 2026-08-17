import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createContactListSchema } from "@/lib/validation";
import {
  AVEC_MEMBRES,
  estDoublonUnique,
  jsonListe,
  listesDe,
  membresResolus,
  repertoireDe,
  reponseNomDejaPris,
} from "@/lib/contact-lists";

// GET /api/contact-lists — les listes de l'utilisateur connecte, de la plus
// ancienne a la plus recente. L'ordre est contractuel, voir ORDRE_LISTES.
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const lists = await listesDe(userId);

  // Un seul aller-retour de repertoire pour TOUTE la reponse, membres de toutes
  // les listes confondus : `isContact` et l'alias se lisent a la meme source, et
  // les interroger liste par liste — ou pire, membre par membre — multiplierait
  // les requetes par l'effectif affiche.
  const repertoire = await repertoireDe(
    userId,
    lists.flatMap((l) => l.members.map((m) => m.memberId)),
  );

  return ok({ lists: lists.map((l) => jsonListe(l, repertoire)) });
});

// POST /api/contact-lists — cree une liste, avec ses membres eventuels.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const data = createContactListSchema.parse(await req.json());

  const existant = await prisma.contactList.findUnique({
    where: { userId_name: { userId, name: data.name } },
    select: { id: true },
  });
  if (existant) return reponseNomDejaPris();

  const { ids, unknownNumbers } = await membresResolus(
    userId,
    data.memberIds,
    data.memberNumbers,
  );

  try {
    const list = await prisma.contactList.create({
      data: {
        userId,
        name: data.name,
        ringtone: data.ringtone ?? null,
        color: data.color ?? null,
        // Creation imbriquee : la liste et ses membres arrivent dans la meme
        // transaction, sinon un echec a mi-chemin laisserait une liste vide que
        // l'utilisateur croirait peuplee.
        members: { create: ids.map((memberId) => ({ memberId })) },
      },
      include: AVEC_MEMBRES,
    });

    // Le repertoire est lu APRES l'ecriture, sur les membres que la base a
    // reellement inscrits : c'est la seule facon de ne pas decrire un ensemble
    // different de celui qui est en base.
    const repertoire = await repertoireDe(userId, list.members.map((m) => m.memberId));

    // `unknownNumbers` accompagne la liste creee : elle EXISTE, un numero
    // introuvable ne l'annule pas. C'est a l'interface de signaler le manquant.
    return ok({ list: jsonListe(list, repertoire), unknownNumbers }, 201);
  } catch (err) {
    if (estDoublonUnique(err)) return reponseNomDejaPris();
    throw err;
  }
});
