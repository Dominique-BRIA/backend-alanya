import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import {
  centresDeLEntreprise,
  chercherEntreprises,
  entreprisesDuType,
  paysAvecEntreprises,
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

  // ── Les pays qui ont au moins une entreprise ───────────────────────────
  //
  // Ce que le filtre de l'écran propose. Servi à part de la navigation : la
  // liste ne dépend ni du type regardé ni du pays courant, et la recharger à
  // chaque changement de type serait du travail pour rien.
  if (params.get("pays-disponibles") !== null) {
    return ok({ pays: await paysAvecEntreprises() });
  }

  /*
   * LE PAYS RETENU — celui du filtre de l'écran, à défaut celui de l'appelant.
   *
   * 🔴 LE CLIENT PEUT DÉSORMAIS LE CHOISIR (demande du user, 31/08/2026).
   * L'ancien commentaire disait qu'« un client n'a pas à décider quel pays il
   * prétend habiter » — c'était vrai tant que le pays servait à borner ce qu'on
   * a le droit de voir. Ce n'est pas le cas ici : l'annuaire des entreprises
   * est PUBLIC, et le pays n'y est qu'un critère d'affichage. Rien ne se
   * protège en le refusant, et le refuser interdisait de regarder ailleurs.
   *
   * ⚠️ Le pays de l'appelant reste le DÉFAUT : un client qui n'envoie rien —
   * l'ancienne application, le web — se comporte exactement comme avant.
   */
  const paysDemande = params.get("pays");
  let idPays: number | null;
  if (paysDemande !== null && paysDemande.trim() !== "") {
    const n = Number(paysDemande);
    if (!Number.isInteger(n) || n <= 0) {
      return fail("Pays invalide", 400, "BAD_COUNTRY");
    }
    idPays = n;
  } else {
    const moi = await prisma.user.findUnique({
      where: { id: userId },
      select: { idPays: true },
    });
    idPays = moi?.idPays ?? null;
  }

  /*
   * ── La recherche ─────────────────────────────────────────────────────
   *
   * 🔴 ELLE SUIT LE FILTRE DEPUIS LE 31/08/2026 (demande du user). Elle
   * l'ignorait auparavant, à sa demande aussi : ne pas revenir en arrière sans
   * lui. Voir `chercherEntreprises`, qui porte la conséquence.
   *
   * Toujours prioritaire sur la navigation par type : on cherche dans un pays,
   * pas dans un type.
   */
  if (requete !== null && requete.trim() !== "") {
    return ok({
      recherche: requete,
      entreprises: await chercherEntreprises(requete, idPays),
    });
  }

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
