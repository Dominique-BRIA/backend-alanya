import { prisma } from "@/lib/prisma";
import { readStored } from "@/modules/media/storage";
import { auteurId, routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin } from "@/lib/gestion/reponses";
import { idNumerique } from "@/lib/gestion/outils";

/**
 * GET /api/admin/verifications/documents/:docId — une pièce justificative.
 *
 * ⚠️ DONNÉE SENSIBLE : servie par le serveur (jamais d'adresse publique ni
 * signée qui pourrait circuler), jamais mise en cache, chaque ouverture
 * comptée et inscrite au journal d'audit.
 */
export const GET = routeAdmin("verifications.read", async (_req, session, ctx: { params: Promise<{ docId: string }> }) => {
  const id = idNumerique((await ctx.params).docId, "DOCUMENT_NOT_FOUND");
  const doc = await prisma.gestionVerificationDocument.findUnique({ where: { id } });
  if (!doc) throw new ErreurAdmin(404, "Pièce introuvable", "DOCUMENT_NOT_FOUND");
  const media = await prisma.mediaFile.findUnique({ where: { id: doc.mediaId } });
  if (!media) throw new ErreurAdmin(410, "Pièce effacée", "DOCUMENT_PURGED");
  const octets = await readStored(media.url, media.espace);
  await prisma.gestionVerificationDocument.update({ where: { id }, data: { vues: { increment: 1 } } });
  await prisma.gestionAudit.create({
    data: {
      admin: auteurId(session),
      adminNom: session.nom.slice(0, 100),
      action: "verifications.document",
      route: `GET /api/admin/verifications/documents/${id}`,
      cibleType: "verifications",
      cibleId: String(doc.verificationId),
      statutHttp: 200,
    },
  });
  return new Response(new Uint8Array(octets), {
    headers: {
      "Content-Type": media.mimeType,
      "Cache-Control": "no-store",
      "Content-Disposition": "inline",
    },
  });
});
