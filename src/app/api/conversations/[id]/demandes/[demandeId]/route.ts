import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";
import { estAdminDuGroupe } from "@/lib/groupe-droits.mjs";
import { deciderDemande } from "@/lib/groupe-adhesion";

/**
 * POST /api/conversations/:id/demandes/:demandeId — accepter ou refuser
 * (18/11/2026). Corps : `{ decision: "accepter" | "refuser" }`. Les admins.
 *
 * Une demande déjà traitée (par un autre admin, à l'instant) rend 409
 * `DEJA_TRAITEE` : le client relit la liste.
 */
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId, demandeId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  if (body?.decision !== "accepter" && body?.decision !== "refuser") {
    return fail("Décision invalide", 400, "BAD_DECISION");
  }
  // Un identifiant qui n'est pas un UUID ferait lever la base : on répond 404.
  if (!/^[0-9a-f-]{36}$/i.test(demandeId ?? "")) {
    return fail("Demande introuvable", 404, "NOT_FOUND");
  }

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: {
      participants: {
        where: MEMBRE_ACTIF,
        select: { userId: true, role: true },
        orderBy: { joinedAt: "asc" },
      },
    },
  });
  if (!conv) return fail("Conversation introuvable", 404, "NOT_FOUND");
  if (!conv.isGroup) return fail("Ce n'est pas un groupe", 400, "NOT_GROUP");
  if (!estAdminDuGroupe(conv.participants, userId)) {
    return fail("Seul un admin traite les demandes", 403, "NOT_ADMIN");
  }

  const r = await deciderDemande(conv, demandeId, userId, body.decision === "accepter");
  if (!r.ok) {
    if ("refus" in r) return NextResponse.json({ error: r.refus }, { status: 409 });
    return r.code === "NOT_FOUND"
      ? fail("Demande introuvable", 404, "NOT_FOUND")
      : fail("Demande déjà traitée", 409, "DEJA_TRAITEE");
  }
  return ok({ statut: r.statut });
});
