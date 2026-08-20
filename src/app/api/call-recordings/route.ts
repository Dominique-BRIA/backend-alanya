import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createCallRecordingSchema } from "@/lib/validation";
import { estDoublonUnique } from "@/lib/contact-lists";
import { melangerEnregistrement } from "@/lib/melange-enregistrement";

/**
 * POST /api/call-recordings — dépose l'enregistrement d'une conversation
 * agent ↔ client.
 *
 * ⚠️ **NI CONSENTEMENT NI NOTIFICATION DE L'APPELANT** — décision explicite du
 * user (20/08/2026). Rien n'est annoncé au correspondant, ni pendant l'appel ni
 * après. Écrit ici pour que ce soit une décision tracée et non un oubli.
 *
 * DEUX MÉDIAS, PAS UN : le greffon WebRTC du mobile ne sait enregistrer qu'un
 * côté à la fois. Le mélange se fait plus tard, côté serveur — voir
 * `melange-enregistrement.ts`.
 *
 * 🔴 IDEMPOTENT PAR CONSTRUCTION, comme les plaintes vocales : `cleEnvoi` est
 * posée par le client, une par enregistrement, et l'unicité est tenue en base.
 * Un réessai après échec réseau rend **200 avec l'enregistrement existant**.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const data = createCallRecordingSchema.parse(await req.json());

  /*
   * L'AGENT EST CELUI QUI ENVOIE, jamais un identifiant reçu du client.
   *
   * On revérifie tout de même son autorisation : `enregistrer` a été calculé au
   * décrochage, mais rien n'empêcherait un client modifié de déposer sans être
   * passé par là. La règle vit dans `center`, on la relit.
   */
  const autorise = await prisma.center.findFirst({
    where: { users_alanyaID: userId, enregistrement: true },
    select: { idCenter: true },
  });
  if (!autorise) {
    return fail("Enregistrement non autorisé pour cet agent", 403, "NOT_ALLOWED");
  }

  // Les deux médias doivent exister ET appartenir à l'agent. Sans ce contrôle,
  // n'importe qui rattacherait l'audio d'un autre à un enregistrement.
  const medias = await prisma.mediaFile.findMany({
    where: { id: { in: [data.mediaAgentId, data.mediaClientId] }, ownerId: userId },
    select: { id: true, durationMs: true },
  });
  if (medias.length !== 2) {
    return fail("Pistes introuvables", 404, "MEDIA_NOT_FOUND");
  }

  /*
   * LE CORRESPONDANT est déduit de l'appel, pas envoyé par le client : c'est la
   * seule source qui ne puisse pas être falsifiée. Absent quand l'appel a été
   * purgé, ce qui reste acceptable — l'enregistrement vaut par son audio.
   */
  let clientId: string | null = null;
  if (data.callId) {
    const autre = await prisma.callParticipant.findFirst({
      where: { callId: data.callId, userId: { not: userId } },
      select: { userId: true },
    });
    clientId = autre?.userId ?? null;
  }

  try {
    const enregistrement = await prisma.callRecording.create({
      data: {
        idCompany: data.companyId,
        callId: data.callId ?? null,
        agentId: userId,
        clientId,
        mediaAgentId: data.mediaAgentId,
        mediaClientId: data.mediaClientId,
        dureeMs: data.dureeMs ?? medias[0].durationMs ?? 0,
        cleEnvoi: data.cleEnvoi,
      },
      select: { idRecording: true, createdAt: true, statut: true },
    });
    /*
     * ⚠️ LE MÉLANGE EST LANCÉ SANS ÊTRE ATTENDU. Il peut prendre plusieurs
     * secondes sur un appel long, et le téléphone n'a aucune raison de patienter
     * — l'appel est déjà terminé, il vient seulement de déposer.
     *
     * Ce n'est possible que parce que le serveur est un process Node durable
     * (`next start` sous PM2) et non une fonction serverless, où tout travail
     * postérieur à la réponse serait tué.
     *
     * Si le process meurt en plein mélange, la ligne reste en `statut = 1` avec
     * ses deux pistes : rien n'est perdu, un balayage pourra la reprendre —
     * l'index partiel `call_recording_a_melanger_idx` existe pour cette
     * requête-là.
     */
    void melangerEnregistrement(enregistrement.idRecording);
    return ok({ recording: enregistrement }, 201);
  } catch (err) {
    if (estDoublonUnique(err)) {
      const existant = await prisma.callRecording.findUnique({
        where: { cleEnvoi: data.cleEnvoi },
        select: { idRecording: true, createdAt: true, statut: true },
      });
      if (existant) return ok({ recording: existant });
    }
    throw err;
  }
});
