import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import {
  centresDeLEntreprise,
  chercherEntreprises,
  entreprisesDuType,
  typesDEntreprise,
} from "@/lib/annuaire-entreprises";

/**
 * GET /api/entreprises                → les types d'entreprise
 * GET /api/entreprises?type=<id>      → les entreprises de ce type, DANS MON PAYS
 * GET /api/entreprises?q=<texte>      → recherche, TOUS PAYS confondus
 * GET /api/entreprises?entreprise=<id> → ses centres et leurs services
 *
 * ── QUI Y A DROIT ────────────────────────────────────────────────────────
 *
 * 🔴 TOUT COMPTE CONNECTÉ, ET C'EST DÉLIBÉRÉMENT DIFFÉRENT DE `/api/collegues`.
 *
 * L'onglet, lui, n'est montré qu'aux comptes de type 0 — les particuliers — un
 * agent voyant l'onglet Collègues à la même place. Mais c'est un choix de
 * PRODUIT, pas de sécurité, et la route ne doit pas le confondre avec une
 * autorisation.
 *
 * Ce qu'il y a derrière est un annuaire public : des raisons sociales et des
 * numéros de standard, faits pour être composés. Rien ne justifie de le refuser
 * à un agent — il a le droit d'appeler le service client d'une autre entreprise
 * comme n'importe qui.
 *
 * `/api/collegues` répond 403 pour la raison inverse : elle expose l'annuaire
 * INTERNE d'un employeur, qui ne regarde que ses agents. Copier son 403 ici
 * aurait été confondre « on ne l'affiche pas » avec « on n'y a pas droit ».
 */
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  const params = req.nextUrl.searchParams;
  const requete = params.get("q");
  const type = params.get("type");
  const entreprise = params.get("entreprise");

  // ── La fiche d'une entreprise ──────────────────────────────────────────
  if (entreprise !== null) {
    const idCompany = Number(entreprise);
    if (!Number.isInteger(idCompany)) {
      return fail("Entreprise invalide", 400, "BAD_COMPANY");
    }
    const fiche = await prisma.company.findUnique({
      where: { idCompany },
      select: {
        idCompany: true,
        libelle: true,
        description: true,
        adresse: true,
        pays: { select: { libelle: true } },
        ville: { select: { nom: true } },
      },
    });
    if (!fiche) return fail("Entreprise introuvable", 404, "NOT_FOUND");

    return ok({ entreprise: fiche, centres: await centresDeLEntreprise(idCompany) });
  }

  /*
   * ── La recherche ─────────────────────────────────────────────────────
   *
   * Prioritaire sur la navigation par type, et SANS filtre de pays : c'est ce
   * qui permet de trouver une entreprise étrangère, et le seul chemin vers une
   * entreprise dont le pays n'est pas renseigné.
   */
  if (requete !== null && requete.trim() !== "") {
    return ok({
      recherche: requete,
      entreprises: await chercherEntreprises(requete),
    });
  }

  /*
   * Le pays de l'appelant : c'est lui qui borne la NAVIGATION, jamais la
   * recherche. Lu à chaque appel plutôt que porté par le client — un client
   * n'a pas à décider quel pays il prétend habiter.
   */
  const moi = await prisma.user.findUnique({
    where: { id: userId },
    select: { idPays: true },
  });
  const idPays = moi?.idPays ?? null;

  // ── Les entreprises d'un type ──────────────────────────────────────────
  if (type !== null) {
    const idTypeCompany = Number(type);
    if (!Number.isInteger(idTypeCompany)) {
      return fail("Type invalide", 400, "BAD_TYPE");
    }
    return ok({
      idTypeCompany,
      entreprises: await entreprisesDuType(idTypeCompany, idPays),
    });
  }

  // ── Les types ──────────────────────────────────────────────────────────
  return ok({ types: await typesDEntreprise(idPays) });
});
