import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { prisma } from "@/lib/prisma";
import { centresDeLAgent } from "@/lib/queue-agents";

/**
 * GET /api/queue/live — clients ACTUELLEMENT en attente (table `file`).
 *
 * Réservé aux agents (voir `centresDeLAgent`), même garde que `/history`.
 * `centerAlanyaID` (optionnel) : un seul centre, doit faire partie des siens ;
 * sans lui, tous les centres de l'appelant sont couverts (utile à un agent qui
 * en sert plusieurs).
 */
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const mesCentres = await centresDeLAgent(userId);
    if (mesCentres.length === 0) {
      return fail("Réservé aux agents d'un centre d'appels", 403, "NOT_AGENT");
    }

    const { searchParams } = new URL(req.url);
    const centerParam = searchParams.get("centerAlanyaID");
    if (centerParam && !mesCentres.includes(centerParam)) {
      return fail("Ce centre ne fait pas partie des vôtres", 403, "FORBIDDEN_CENTER");
    }
    const centerIds = centerParam ? [centerParam] : mesCentres;

    const lignes = await prisma.queueFile.findMany({
      where: { center_alanyaID: { in: centerIds } },
      orderBy: [{ center_alanyaID: "asc" }, { priorite: "desc" }, { rang: "asc" }],
      include: {
        customer: { select: { pseudo: true, publicNumber: true, avatarUrl: true } },
        service: { select: { libelle: true } },
      },
    });

    return ok({
      live: lignes.map((l) => ({
        idFile: l.idFile,
        centerAlanyaID: l.center_alanyaID,
        idCustomer: l.idCustomer,
        customerName: l.customer?.pseudo ?? l.customer?.publicNumber ?? null,
        customerAvatarUrl: l.customer?.avatarUrl ?? null,
        rang: l.rang,
        priorite: l.priorite,
        createdAt: l.createdAt.toISOString(),
        idService: l.idService,
        serviceName: l.service?.libelle ?? null,
      })),
    });
  } catch (e: any) {
    return fail(`Erreur lors de la lecture de la file d'attente: ${e?.message ?? e}`, 500);
  }
});
