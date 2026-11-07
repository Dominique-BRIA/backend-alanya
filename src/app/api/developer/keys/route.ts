import { type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ok, handleError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { generateApiKey } from "@/lib/developer/key-service";
import { enseigneDuProprietaire } from "@/lib/developer/enseignes";

/**
 * LES CLÉS API D'UNE ENSEIGNE (07/11/2026).
 *
 * Chaque route vise UNE enseigne (`enseigne` en paramètre de requête, ou
 * `enseigneId` dans le corps) et vérifie qu'elle appartient à la personne
 * connectée. Rien n'est créé à la lecture.
 *
 * 🔴 PLUS DE CHOIX SANDBOX / PRODUCTION : les deux produisaient des effets
 * réels. Toutes les clés commencent par `ak_live_`.
 *
 * La liste montre ce qui permet de reconnaître une clé sans la révéler, comme
 * les consoles de Stripe ou d'OpenAI : son nom, ses 12 premiers caractères
 * (les mêmes que dans le journal), sa date de création et sa dernière
 * utilisation. La clé entière n'est montrée qu'une fois, à sa création.
 */

const SELECTION_CLE = {
  id: true,
  name: true,
  prefix: true,
  isActive: true,
  lastUsedAt: true,
  createdAt: true,
} as const;

// GET /api/developer/keys?enseigne=<id>
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const enseigne = await enseigneDuProprietaire(userId, req.nextUrl.searchParams.get("enseigne"));
    const cles = await prisma.apiKey.findMany({
      where: { developerId: enseigne.id },
      orderBy: { createdAt: "desc" },
      select: SELECTION_CLE,
    });
    return ok({ cles });
  } catch (err) {
    return handleError(err);
  }
});

const creationSchema = z.object({
  enseigneId: z.string().uuid(),
  nom: z.string().trim().max(50).optional(),
});

// POST /api/developer/keys — `{ enseigneId, nom? }` → la clé, montrée UNE fois.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const corps = creationSchema.parse(await req.json().catch(() => ({})));
    const enseigne = await enseigneDuProprietaire(userId, corps.enseigneId);

    const { rawKey, keyHash, prefix } = generateApiKey();
    const cle = await prisma.apiKey.create({
      data: {
        developerId: enseigne.id,
        name: corps.nom || "Clé API",
        keyHash,
        prefix,
      },
      select: SELECTION_CLE,
    });

    return ok(
      {
        // ⚠️ La clé entière n'est rendue qu'ICI : seule son empreinte est gardée.
        cleComplete: rawKey,
        cle,
      },
      201,
    );
  } catch (err) {
    return handleError(err);
  }
});

const revocationSchema = z.object({
  enseigneId: z.string().uuid(),
  cleId: z.string().uuid(),
});

// DELETE /api/developer/keys — `{ enseigneId, cleId }` : la clé cesse aussitôt de marcher.
export const DELETE = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const corps = revocationSchema.parse(await req.json().catch(() => ({})));
    const enseigne = await enseigneDuProprietaire(userId, corps.enseigneId);
    await prisma.apiKey.updateMany({
      where: { id: corps.cleId, developerId: enseigne.id },
      data: { isActive: false },
    });
    return ok({ message: "Clé révoquée." });
  } catch (err) {
    return handleError(err);
  }
});
