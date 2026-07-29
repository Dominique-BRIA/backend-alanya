import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, handleError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

/** Nombre de connexions renvoyées par défaut, et plafond absolu. */
const PAR_DEFAUT = 30;
const MAXIMUM = 200;

// GET /api/user-access — historique des connexions du compte connecté,
// de la plus récente à la plus ancienne.
//
// Aucun identifiant d'utilisateur en paramètre : on ne renvoie jamais que ses
// propres connexions. Un journal d'accès est une donnée sensible — il révèle
// les habitudes, les horaires et la localisation approximative d'une personne.
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const demande = Number(req.nextUrl.searchParams.get("limit") ?? PAR_DEFAUT);
    const limit = Number.isFinite(demande)
      ? Math.min(Math.max(Math.trunc(demande), 1), MAXIMUM)
      : PAR_DEFAUT;

    const lignes = await prisma.userAccess.findMany({
      where: { alanyaId: userId },
      orderBy: { dateLogin: "desc" },
      take: limit,
    });

    return ok({
      acces: lignes.map((l) => ({
        // `idLogin` est un BigInt côté base : JSON.stringify ne sait pas le
        // sérialiser, d'où la conversion explicite en nombre.
        idLogin: Number(l.idLogin),
        device: l.device,
        ipAdress: l.ipAdress,
        osSystem: l.osSystem,
        dateLogin: l.dateLogin.toISOString(),
      })),
    });
  } catch (err) {
    return handleError(err);
  }
});
