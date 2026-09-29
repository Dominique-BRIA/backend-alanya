import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { rateLimit } from "@/lib/rate-limit";
import {
  DUREE_INVITATION_MS,
  GARDE_APRES_EXPIRATION_MS,
  INVITATIONS_PAR_HEURE,
  lienInvitation,
  nouveauJeton,
} from "@/lib/invitation-qr";

// POST /api/invitations — crée une invitation à usage unique (15 minutes).
// Réponse : { jeton, lien, expireLe, dureeSecondes }
export const POST = withAuth(async (_req: NextRequest, userId: string) => {
  // ⚠️ `await` indispensable : sans lui, `rl` est une Promise et la limite
  // disparaît sans erreur (voir rate-limit.ts).
  const rl = await rateLimit(
    `invitation-qr:${userId}`,
    INVITATIONS_PAR_HEURE,
    3_600_000,
  );
  if (!rl.allowed) {
    return fail(
      "Trop de QR générés, réessaie dans quelques minutes",
      429,
      "RATE_LIMITED",
    );
  }

  const maintenant = Date.now();

  // Ménage : les invitations périmées depuis plus d'un jour. Fait ici plutôt
  // que par une tâche planifiée — la table ne grossit que par ce chemin.
  await prisma.invitationQr.deleteMany({
    where: { expireLe: { lt: new Date(maintenant - GARDE_APRES_EXPIRATION_MS) } },
  });

  const inv = await prisma.invitationQr.create({
    data: {
      jeton: nouveauJeton(),
      createurId: userId,
      // ⚠️ Les deux dates viennent de la MÊME horloge. Laisser `cree_le` au
      // `now()` de la base et calculer `expire_le` ici exposerait la
      // contrainte `expire_le > cree_le` au moindre écart d'horloge entre le
      // serveur d'API et PostgreSQL.
      creeLe: new Date(maintenant),
      expireLe: new Date(maintenant + DUREE_INVITATION_MS),
    },
  });

  return ok(
    {
      jeton: inv.jeton,
      lien: lienInvitation(inv.jeton),
      expireLe: inv.expireLe.toISOString(),
      dureeSecondes: DUREE_INVITATION_MS / 1000,
    },
    201,
  );
});
