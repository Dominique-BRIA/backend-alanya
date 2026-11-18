import { type NextRequest, NextResponse } from "next/server";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { annulerDemande, groupeDuCode, rejoindreParLien } from "@/lib/groupe-adhesion";

/**
 * POST /api/groupes/lien/:code/rejoindre — confirmer (18/11/2026).
 *
 *  - groupe public : on entre → `{ etat: "membre", convId }` ;
 *  - groupe privé (ou ancien membre retiré par un admin) : la demande part
 *    aux admins → `{ etat: "attente", convId }` ;
 *  - déjà membre : `{ etat: "membre", deja: true }`, rien ne change.
 *
 * Groupe chiffré dont ce compte ne pourrait rien lire : 409 avec le même
 * code que l'ajout par un membre (`HORS_PERIMETRE`, `CLES_MANQUANTES`).
 */
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { code } = await ctx.params;
  const conv = await groupeDuCode(code);
  if (!conv) return fail("Ce lien de groupe n'est plus valable", 404, "LIEN_INVALIDE");

  const r = await rejoindreParLien(conv, userId);
  if ("refus" in r) return NextResponse.json({ error: r.refus }, { status: 409 });
  return ok(r);
});

/** DELETE /api/groupes/lien/:code/rejoindre — retirer sa demande en attente. */
export const DELETE = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { code } = await ctx.params;
  const conv = await groupeDuCode(code);
  if (!conv) return fail("Ce lien de groupe n'est plus valable", 404, "LIEN_INVALIDE");

  const retiree = await annulerDemande(conv.id, userId);
  if (!retiree) return fail("Aucune demande en attente", 404, "AUCUNE_DEMANDE");
  return ok({ etat: "aucun", convId: conv.id });
});
