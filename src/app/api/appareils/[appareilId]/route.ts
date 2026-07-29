import { type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { serializeAppareil } from "@/lib/appareils";

const updateSchema = z.object({
  libelle: z.string().trim().min(1).max(45).optional(),
  isOnline: z.number().int().min(0).max(1).optional(),
  system: z.string().trim().max(45).optional(),
  typeDevice: z.number().int().min(0).max(9).optional(),
});

/// Retrouve l'appareil et vérifie qu'il appartient bien à l'appelant.
///
/// Le contrôle est indispensable : `appareilId` est un entier séquentiel, donc
/// devinable. Sans lui, n'importe qui pourrait renommer ou déconnecter
/// l'appareil d'un autre compte en incrémentant un nombre.
async function ownedAppareil(appareilId: number, userId: string) {
  const appareil = await prisma.appareil.findUnique({ where: { appareilId } });
  if (!appareil) return { error: fail("Appareil introuvable", 404, "NOT_FOUND") };
  if (appareil.alanyaId !== userId) {
    // Même réponse que pour un appareil inexistant : distinguer les deux cas
    // révélerait quels identifiants sont attribués.
    return { error: fail("Appareil introuvable", 404, "NOT_FOUND") };
  }
  return { appareil };
}

// PUT /api/appareils/:appareilId — met à jour l'appareil (libellé donné par
// l'utilisateur, présence, système).
export const PUT = withAuth(async (req: NextRequest, userId: string, ctx) => {
  try {
    const appareilId = Number((await ctx.params).appareilId);
    if (!Number.isInteger(appareilId) || appareilId <= 0) {
      return fail("Identifiant d'appareil invalide", 400, "BAD_ID");
    }

    const found = await ownedAppareil(appareilId, userId);
    if (found.error) return found.error;

    const body = updateSchema.parse(await req.json());
    const updated = await prisma.appareil.update({
      where: { appareilId },
      data: {
        ...(body.libelle !== undefined ? { libelle: body.libelle } : {}),
        ...(body.system !== undefined ? { system: body.system } : {}),
        ...(body.typeDevice !== undefined ? { typeDevice: body.typeDevice } : {}),
        ...(body.isOnline !== undefined ? { isOnline: body.isOnline } : {}),
        // Toute mise à jour vaut signe de vie : c'est ce qui alimente la colonne
        // « vu pour la dernière fois » de l'écran Appareils connectés.
        lastLogin: new Date(),
      },
    });

    return ok({ appareil: serializeAppareil(updated) });
  } catch (err) {
    return handleError(err);
  }
});

// DELETE /api/appareils/:appareilId — déconnexion à distance.
//
// Effacement logique : la ligne survit avec `destroy = 1`, pour que
// l'utilisateur garde trace de l'appareil et de sa dernière connexion. Une
// reconnexion depuis cet appareil le réactivera (voir POST /api/appareils).
export const DELETE = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  try {
    const appareilId = Number((await ctx.params).appareilId);
    if (!Number.isInteger(appareilId) || appareilId <= 0) {
      return fail("Identifiant d'appareil invalide", 400, "BAD_ID");
    }

    const found = await ownedAppareil(appareilId, userId);
    if (found.error) return found.error;

    const updated = await prisma.appareil.update({
      where: { appareilId },
      data: { destroy: 1, isOnline: 0 },
    });

    return ok({ appareil: serializeAppareil(updated) });
  } catch (err) {
    return handleError(err);
  }
});
