import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { publicNumberSchema } from "@/lib/validation";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";
import { areBlocked } from "@/lib/blocking";
import { TYPE_COMPTE_OFFICIEL } from "@/lib/compte-officiel.mjs";

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

/**
 * RECHERCHE PAR LE NOM (11/11/2026), reprise de l'application de référence.
 *
 * `?q=<texte>` rend `{ resultats: [...] }` :
 *  - que des chiffres (espaces tolérés) → l'Alanya ID, comme `?number=` ;
 *  - sinon → les comptes dont le NOM ou le PSEUDO est EXACTEMENT ce texte
 *    (casse et espaces de bord ignorés).
 *
 * 🔴 EXACT, ET NON « CONTIENT » — comme chez eux, et pour la même raison : une
 * recherche partielle permettrait de parcourir l'annuaire lettre par lettre
 * (« a », « b »…) et d'en extraire tous les comptes. Il faut connaître le nom
 * de quelqu'un pour le trouver.
 *
 * Écartés : moi-même, le compte officiel (type 5, il ne s'ajoute pas), les
 * comptes supprimés ou exclus, et tout compte avec qui un blocage existe,
 * dans un sens ou dans l'autre.
 *
 * `?number=` garde sa forme d'origine (un seul résultat, 404 sinon) : les
 * versions installées des applications s'en servent.
 */
const MAX_RESULTATS = 20;

async function rechercher(userId: string, brut: string) {
  const texte = brut.trim().replace(/\s+/g, " ");
  if (texte.length < 2 || texte.length > 100) return [];

  const chiffres = texte.replace(/\s/g, "");
  const parNumero = /^\d+$/.test(chiffres);
  if (parNumero && !publicNumberSchema.safeParse(chiffres).success) return [];

  const trouves = await prisma.user.findMany({
    where: {
      ...(parNumero
        ? { publicNumber: chiffres }
        : {
            OR: [
              { nom: { equals: texte, mode: "insensitive" } },
              { pseudo: { equals: texte, mode: "insensitive" } },
            ],
          }),
      id: { not: userId },
      typeCompte: { not: TYPE_COMPTE_OFFICIEL },
      isDelete: false,
      exclus: 0,
    },
    take: MAX_RESULTATS,
    orderBy: { nom: "asc" },
  });

  const visibles = [];
  for (const u of trouves) {
    if (await areBlocked(userId, u.id)) continue;
    visibles.push(u);
  }
  const contacts = await prisma.contact.findMany({
    where: { userId, contactId: { in: visibles.map((u) => u.id) } },
    select: { contactId: true },
  });
  const dejaContacts = new Set(contacts.map((c) => c.contactId));

  return visibles.map((u) => ({
    id: u.id,
    publicNumber: u.publicNumber,
    pseudo: nomAffichage(u),
    avatarUrl: avatarPublicUrl(u.avatarUrl ?? null),
    statusMsg: u.statusMsg ?? null,
    alreadyContact: dejaContacts.has(u.id),
  }));
}

// GET /api/users/search?number=123456   |   GET /api/users/search?q=Marie%20Ngo
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  const q = req.nextUrl.searchParams.get("q");
  if (q !== null) return ok({ resultats: await rechercher(userId, q) });

  const raw = req.nextUrl.searchParams.get("number") ?? "";
  const parsed = publicNumberSchema.safeParse(raw);
  // Le message vient du schéma : c'est lui qui porte les bornes, et un message
  // écrit en dur ici a déjà menti pendant des mois (« 6 chiffres exactement »
  // alors que 8 était accepté).
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Numéro invalide", 422, "BAD_NUMBER");
  }

  const number = parsed.data;
  const found = await prisma.user.findUnique({
    where: { publicNumber: number },
  });

  if (!found || found.id === userId) {
    return fail("Aucun utilisateur avec ce numéro", 404, "NOT_FOUND");
  }

  const existing = await prisma.contact.findUnique({
    where: { userId_contactId: { userId, contactId: found.id } },
    select: { id: true },
  });

  return ok({
    id: found.id,
    publicNumber: found.publicNumber,
    pseudo: nomAffichage(found),
    avatarUrl: avatarPublicUrl(found.avatarUrl ?? null),
    statusMsg: found.statusMsg ?? null,
    alreadyContact: Boolean(existing),
  });
});
