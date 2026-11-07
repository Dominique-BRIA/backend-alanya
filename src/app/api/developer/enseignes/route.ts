import { type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import {
  SELECTION_ENSEIGNE,
  confirmationRequise,
  creerEnseigne,
  limiteDEnseignes,
  peutCreerUneEnseigne,
  presenterEnseigne,
} from "@/lib/developer/enseignes";

/**
 * GET /api/developer/enseignes — ce que la console affiche en entrant.
 *
 * 🔴 NE CRÉE RIEN (07/11/2026). Les anciennes routes de la console créaient un
 * compte développeur à la simple lecture : ouvrir la page suffisait à devenir
 * développeur. Ici, on lit seulement ; une enseigne n'existe que si on la crée.
 *
 * Réponse :
 *   `autorise`             ce compte peut-il créer une enseigne ? (non pour un
 *                          agent, un centre d'appels, un centre vocal) ;
 *   `limite`               nombre d'enseignes permis par personne ;
 *   `confirmationRequise`  faut-il d'abord un code reçu dans l'application ?
 *   `enseignes`            celles de la personne.
 */
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const moi = await prisma.user.findUnique({ where: { id: userId }, select: { typeCompte: true } });
  if (!moi) return fail("Compte introuvable.", 404, "NOT_FOUND");

  const [enseignes, limite, confirmation] = await Promise.all([
    prisma.developerAccount.findMany({
      where: { proprietaireId: userId },
      orderBy: { createdAt: "asc" },
      select: SELECTION_ENSEIGNE,
    }),
    limiteDEnseignes(),
    confirmationRequise(userId),
  ]);

  return ok({
    autorise: peutCreerUneEnseigne(moi.typeCompte),
    limite,
    confirmationRequise: confirmation,
    enseignes: enseignes.map(presenterEnseigne),
  });
});

const creationSchema = z.object({
  nom: z.string().trim().min(2, "Le nom compte au moins 2 caractères").max(60),
});

/**
 * POST /api/developer/enseignes — `{ nom }` → l'enseigne créée, avec son numéro.
 *
 * Refus possibles, chacun avec son code :
 *   403 `TYPE_COMPTE_EXCLU`     agent, centre d'appels, centre vocal ;
 *   403 `CONFIRMATION_REQUISE`  le compte a l'application : il faut d'abord le
 *                               code (`POST /api/developer/confirmation`) ;
 *   409 `LIMITE_ENSEIGNES`      nombre maximal atteint.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const { nom } = creationSchema.parse(await req.json().catch(() => ({})));

    const moi = await prisma.user.findUnique({ where: { id: userId }, select: { typeCompte: true } });
    if (!moi) return fail("Compte introuvable.", 404, "NOT_FOUND");
    if (!peutCreerUneEnseigne(moi.typeCompte)) {
      return fail(
        "Les comptes agent, centre d'appels et centre vocal ne peuvent pas créer d'enseigne.",
        403,
        "TYPE_COMPTE_EXCLU",
      );
    }
    if (await confirmationRequise(userId)) {
      return fail(
        "Confirmez d'abord votre identité avec le code envoyé dans l'application Alanya.",
        403,
        "CONFIRMATION_REQUISE",
      );
    }

    const enseigne = await creerEnseigne(userId, nom);
    return ok({ enseigne: presenterEnseigne(enseigne) }, 201);
  } catch (err) {
    return handleError(err);
  }
});
