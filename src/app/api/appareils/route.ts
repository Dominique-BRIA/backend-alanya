import { type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ok, handleError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { serializeAppareil } from "@/lib/appareils";

// Identifiant stable de l'appareil, fabriqué et conservé par le client (le web
// le garde en localStorage). Le nom vient du référentiel équipe, mais il vaut
// pour toutes les plateformes : le mobile envoie simplement un UUID persistant.
const upsertSchema = z.object({
  cookiesWebId: z.string().trim().min(8).max(255),
  libelle: z.string().trim().min(1).max(45).optional(),
  typeDevice: z.number().int().min(0).max(9).optional(),
  system: z.string().trim().max(45).optional(),
  isOnline: z.number().int().min(0).max(1).optional(),
});

// GET /api/appareils — les appareils du compte connecté, actifs d'abord,
// puis du plus récemment vu au plus ancien.
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  try {
    const rows = await prisma.appareil.findMany({
      where: { idAgent: userId },
      orderBy: [{ destroy: "asc" }, { lastLogin: "desc" }],
    });
    return ok({ appareils: rows.map(serializeAppareil) });
  } catch (err) {
    return handleError(err);
  }
});

// POST /api/appareils — enregistre l'appareil courant, ou le rafraîchit s'il
// est déjà connu. Idempotent : le client peut l'appeler à chaque démarrage.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const body = upsertSchema.parse(await req.json());
    const now = new Date();

    const appareil = await prisma.appareil.upsert({
      where: {
        cookiesWebId_idAgent: { cookiesWebId: body.cookiesWebId, idAgent: userId },
      },
      create: {
        cookiesWebId: body.cookiesWebId,
        idAgent: userId,
        libelle: body.libelle ?? "Appareil",
        typeDevice: body.typeDevice ?? 0,
        system: body.system ?? null,
        isOnline: body.isOnline ?? 1,
        lastLogin: now,
      },
      update: {
        // Le libellé et le type ne sont mis à jour que si le client les fournit :
        // un appareil renommé par l'utilisateur ne doit pas être écrasé par la
        // valeur générique du démarrage suivant.
        ...(body.libelle !== undefined ? { libelle: body.libelle } : {}),
        ...(body.typeDevice !== undefined ? { typeDevice: body.typeDevice } : {}),
        ...(body.system !== undefined ? { system: body.system } : {}),
        isOnline: body.isOnline ?? 1,
        lastLogin: now,
        // Une reconnexion réactive un appareil précédemment déconnecté à
        // distance : c'est bien le même matériel, et l'utilisateur vient de s'y
        // authentifier.
        destroy: 0,
      },
    });

    return ok({ appareil: serializeAppareil(appareil) });
  } catch (err) {
    return handleError(err);
  }
});
