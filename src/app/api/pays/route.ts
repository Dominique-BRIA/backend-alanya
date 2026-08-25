import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createPaysSchema } from "@/lib/validation";

/**
 * GET /api/pays — la liste de référence des pays.
 *
 * 🔴 PUBLIQUE DEPUIS LE 25/08/2026, et c'est ce qui débloque tout le reste.
 *
 * Elle était derrière `withAuth`, donc INJOIGNABLE PENDANT L'INSCRIPTION —
 * `withAuth` exige un jeton de portée `access`, et l'inscription n'a qu'un
 * `setupToken`. Les deux clients contournaient en portant chacun sa PROPRE
 * liste, codée en dur… et fausse : le mobile disait « id 1 = Cameroun » quand
 * la table dit « id 1 = Afrique du Sud ». Mesuré en production le 25/08 : 4
 * comptes enregistrés en Afrique du Sud par des gens qui ont choisi Cameroun,
 * et des numéros en +221 ou +223 rattachés à des pays sans rapport.
 *
 * Rien ici ne mérite d'être protégé : c'est une table de référence, identique
 * pour tout le monde, sans donnée personnelle et sans énumération possible.
 * La protéger n'apportait aucune sécurité et coûtait l'exactitude des comptes.
 *
 * `isDelete` filtré et champs choisis : les clients n'ont besoin que de quoi
 * afficher un choix et formater un numéro.
 */
export async function GET(_req: NextRequest) {
  const pays = await prisma.pays.findMany({
    where: { isDelete: false },
    orderBy: { libelle: "asc" },
    select: {
      idPays: true,
      libelle: true,
      libelleAnglais: true,
      iso2: true,
      prefix: true,
    },
  });
  return ok({ pays });
}

// POST /api/pays — ajoute un pays (admin / seed).
export const POST = withAuth(async (req: NextRequest, _userId: string) => {
  const body = createPaysSchema.parse(await req.json());

  const existing = await prisma.pays.findFirst({
    where: { libelle: body.libelle },
  });
  if (existing) return fail("Ce pays existe déjà", 409, "ALREADY_EXISTS");

  const pays = await prisma.pays.create({ data: body });
  return ok(pays, 201);
});
