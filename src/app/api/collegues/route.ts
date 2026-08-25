import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";
import {
  TYPE_COMPTE_AGENT,
  membresDuService,
  servicesDeLEntreprise,
} from "@/lib/collegues";

/**
 * GET /api/collegues            → les services de mon entreprise
 * GET /api/collegues?service=X  → les collègues du service X
 *
 * ── QUI Y A DROIT ────────────────────────────────────────────────────────
 *
 * Un AGENT, `type_compte = 2`, rattaché à une entreprise. La consigne d'origine
 * disait « type 3 » ; en production, les type 3 sont les STANDARDS eux-mêmes
 * (« Assistance Technique », « Clients Fidèles ») — des comptes de service, pas
 * des personnes. L'annuaire leur aurait été réservé, et caché aux collègues
 * qu'il concerne. Tranché avec le user le 25/08/2026.
 *
 * ⚠️ LE DROIT EST VÉRIFIÉ ICI, PAS SEULEMENT DANS L'ONGLET. Le client masque
 * l'onglet aux non-agents, mais un onglet masqué n'est pas un contrôle d'accès :
 * l'annuaire d'une entreprise n'a aucune raison de répondre à qui n'en fait pas
 * partie.
 *
 * ── UNE SEULE ROUTE, DEUX NIVEAUX ────────────────────────────────────────
 *
 * Le paramètre `service` distingue les deux, plutôt que deux chemins séparés :
 * le contrôle d'accès et la résolution de l'entreprise sont identiques, et les
 * écrire deux fois est le meilleur moyen de les laisser diverger.
 */
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  const moi = await prisma.user.findUnique({
    where: { id: userId },
    select: { idCompany: true, typeCompte: true },
  });
  if (!moi) return fail("Utilisateur introuvable", 404, "NOT_FOUND");

  if (moi.typeCompte !== TYPE_COMPTE_AGENT || moi.idCompany == null) {
    /*
     * 403 et non 404 : la route existe, elle ne s'adresse simplement pas à ce
     * compte. Un 404 laisserait croire à un chemin disparu et enverrait le
     * client chercher une panne là où il n'y en a pas.
     */
    return fail("Cet annuaire est réservé aux agents d'une entreprise", 403, "NOT_AGENT");
  }

  const service = req.nextUrl.searchParams.get("service");

  // ── Niveau 1 : les services ────────────────────────────────────────────
  if (service === null) {
    const services = await servicesDeLEntreprise(moi.idCompany, userId);
    return ok({ services });
  }

  // ── Niveau 2 : les collègues d'un service ──────────────────────────────
  const membres = await membresDuService(moi.idCompany, service, userId);

  return ok({
    service,
    collegues: membres.map((m) => ({
      id: m.id,
      publicNumber: m.publicNumber,
      // Le nom tel que les trois clients l'affichent partout ailleurs — même
      // règle de repli que dans les conversations et les appels.
      nom: nomAffichage(m),
      avatarUrl: avatarPublicUrl(m.avatarUrl ?? null),
      isOnline: m.isOnline,
      lastSeen: m.lastSeen ?? null,
    })),
  });
});
