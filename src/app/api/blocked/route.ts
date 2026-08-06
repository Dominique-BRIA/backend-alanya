import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { blockUserSchema } from "@/lib/validation";
import { mirrorContactBlock } from "@/lib/blocking";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";

// GET /api/blocked — liste des utilisateurs bloqués par l'utilisateur connecté.
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const blocked = await prisma.blocked.findMany({
    where: { alanyaID: userId },
    orderBy: { dateBlock: "desc" },
    include: {
      blockedUser: true,
    },
  });

  /**
   * Blocages SUBIS, c'est-a-dire les comptes qui ont bloque le demandeur.
   *
   * Ils ne sont divulgues QUE si le demandeur a ses accuses de lecture actifs.
   * C'est la meme condition que celle qui declenche l'avis systeme « Vous avez
   * ete bloque par X » a la premiere tentative d'envoi : dans ce cas il le sait
   * deja, et le lui redire ici ne revele rien de neuf.
   *
   * Accuses desactives, la liste reste vide : la regle est qu'il ne doit pas
   * apprendre qu'il est bloque, et cette route ne peut pas etre le trou par
   * lequel l'information passe.
   */
  const moi = await prisma.user.findUnique({
    where: { id: userId },
    select: { readReceipts: true },
  });
  const peutSavoir = (moi?.readReceipts ?? 1) !== 0;

  const blockedBy = peutSavoir
    ? await prisma.blocked.findMany({
        where: { idCallerBlock: userId },
        orderBy: { dateBlock: "desc" },
        include: { owner: true },
      })
    : [];

  return ok({
    blocked: blocked.map((b) => ({
      idBlock: b.idBlock,
      idCallerBlock: b.idCallerBlock,
      pseudo: nomAffichage(b.blockedUser),
      publicNumber: b.blockedUser.publicNumber,
      avatarUrl: avatarPublicUrl(b.blockedUser.avatarUrl ?? null),
      dateBlock: b.dateBlock,
    })),
    blockedBy: blockedBy.map((b) => ({
      idBlock: b.idBlock,
      // L'auteur du blocage, cette fois : c'est lui que le client doit nommer.
      idCallerBlock: b.alanyaID,
      pseudo: nomAffichage(b.owner),
      publicNumber: b.owner.publicNumber,
      avatarUrl: avatarPublicUrl(b.owner.avatarUrl ?? null),
      dateBlock: b.dateBlock,
    })),
  });
});

// POST /api/blocked — bloque un utilisateur par son numéro public.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const body = blockUserSchema.parse(await req.json());

  const target = await prisma.user.findUnique({
    where: { publicNumber: body.publicNumber },
  });
  if (!target) return fail("Aucun utilisateur avec ce numéro", 404, "NOT_FOUND");
  if (target.id === userId) return fail("Tu ne peux pas te bloquer toi-même", 400, "SELF");

  const existing = await prisma.blocked.findUnique({
    where: {
      alanyaID_idCallerBlock: { alanyaID: userId, idCallerBlock: target.id },
    },
  });
  if (existing) return fail("Cet utilisateur est déjà bloqué", 409, "ALREADY_BLOCKED");

  const blocked = await prisma.blocked.create({
    data: {
      alanyaID: userId,
      idCallerBlock: target.id,
    },
  });

  // Miroir : reflète sur Contact.isBlocked si la personne est dans le répertoire.
  await mirrorContactBlock(userId, target.id, true);

  return ok(
    {
      idBlock: blocked.idBlock,
      idCallerBlock: blocked.idCallerBlock,
      dateBlock: blocked.dateBlock,
    },
    201,
  );
});
