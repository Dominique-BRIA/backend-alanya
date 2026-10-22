import { type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { estDoublonUnique } from "@/lib/contact-lists";

const consultationSchema = z
  .object({
    mediaId: z.string().trim().min(1).max(64),
    convId: z.string().trim().max(64).optional(),
    appareil: z.string().trim().max(200).optional(),
    action: z
      .enum(["CONSULTATION", "TELECHARGEMENT", "PARTAGE", "TRANSFERT"])
      .default("CONSULTATION"),
    // Tiré au hasard par l'application, écrit dans la copie signée.
    codeTrace: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
  })
  // Une copie qui sort porte toujours son code ; une lecture n'en a pas.
  .refine((d) => (d.action === "CONSULTATION") === (d.codeTrace === undefined));

/**
 * POST /api/documents-sensibles/consultations — la TRACE d'un document
 * sensible : qui, sur quel appareil, quand, et pour quel geste.
 *
 * * 18/10/2026 : la consultation (le document ne sortait pas de l'application).
 * * 22/10/2026 : téléchargement, partage et transfert sont permis. La copie
 *   qui sort est signée sur l'appareil (bords et métadonnées) avec un
 *   `codeTrace` ; le garder ici permet de remonter, depuis un fichier
 *   retrouvé ailleurs, à qui l'a fait sortir.
 *
 * Le serveur ne lit pas les fichiers chiffrés de bout en bout : la signature
 * est posée par le client. Ne bloque jamais le geste côté client.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const rl = await rateLimit(`consultation:${userId}`, 60, 60_000);
  if (!rl.allowed) return fail("Trop de consultations", 429, "RATE_LIMITED");
  const parsed = consultationSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Données invalides", 422, "VALIDATION");
  const { mediaId, convId, appareil, action, codeTrace } = parsed.data;
  try {
    await prisma.documentConsultation.create({
      data: {
        userId,
        mediaId,
        convId,
        appareil,
        action,
        codeTrace,
        ip: clientIp(req).slice(0, 64),
      },
    });
  } catch (e) {
    if (!estDoublonUnique(e)) throw e;
    // Le même code renvoyé (nouvel essai après une coupure) : déjà noté.
    // Le code d'un autre compte, lui, ne s'écrase pas.
    const existant = await prisma.documentConsultation.findUnique({
      where: { codeTrace },
      select: { userId: true },
    });
    if (existant?.userId !== userId) {
      return fail("Code de trace déjà utilisé", 409, "TRACE_TAKEN");
    }
  }
  return ok({ enregistre: true });
});
