import { prisma } from "@/lib/prisma";
import { HttpError } from "@/lib/http";
import { lireSalle, participantActif, type Salle } from "@/lib/sfu-salle";
import type { Description } from "@/lib/sfu-cloudflare";

/**
 * Ce que partagent les routes `/api/sfu/...` (07/11/2026) : lire et vérifier
 * ce que le client envoie, et retrouver SA session.
 */

/// Une description SDP de groupe tient en quelques dizaines de Ko.
const SDP_MAX = 128 * 1024;

export type PisteSfu = { nom: string; genre: "audio" | "video" };

export function lireDescription(brut: unknown, attendu: "offer" | "answer"): Description {
  const d = brut as { type?: unknown; sdp?: unknown } | null;
  if (!d || d.type !== attendu || typeof d.sdp !== "string" || !d.sdp || d.sdp.length > SDP_MAX) {
    throw new HttpError(400, `Description « ${attendu} » invalide`, "BAD_SDP");
  }
  return { type: attendu, sdp: d.sdp };
}

/// Un nom de piste : court, sans rien d'exotique. Cloudflare l'impose unique
/// par session ; c'est le client qui le choisit (« audio », « video »).
export function lireNomPiste(brut: unknown): string {
  if (typeof brut !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(brut)) {
    throw new HttpError(400, "Nom de piste invalide", "BAD_TRACK");
  }
  return brut;
}

export function lirePistes(brut: unknown): PisteSfu[] {
  if (!Array.isArray(brut)) return [];
  return brut.slice(0, 8).map((p) => {
    const e = p as { nom?: unknown; genre?: unknown };
    return { nom: lireNomPiste(e.nom), genre: e.genre === "video" ? "video" : "audio" };
  });
}

export function pistesStockees(brut: unknown): PisteSfu[] {
  if (!Array.isArray(brut)) return [];
  return brut.filter(
    (p): p is PisteSfu =>
      !!p && typeof (p as PisteSfu).nom === "string" && ((p as PisteSfu).genre === "audio" || (p as PisteSfu).genre === "video"),
  );
}

export async function salleAutorisee(brut: unknown, userId: string): Promise<Salle> {
  const salle = lireSalle(brut);
  if (!salle) throw new HttpError(400, "Salle invalide", "BAD_ROOM");
  if (!(await participantActif(salle, userId))) {
    throw new HttpError(403, "Vous n'êtes pas dans cet appel", "FORBIDDEN");
  }
  return salle;
}

/**
 * La session [sessionId], si elle est À [userId], toujours ouverte, et que
 * sa salle l'accepte encore (un participant parti ne publie plus rien).
 */
export async function maSession(sessionId: string, userId: string) {
  const s = await prisma.sfuSession.findUnique({ where: { sessionId } });
  if (!s || s.userId !== userId || s.fermeLe) {
    throw new HttpError(404, "Session introuvable", "NOT_FOUND");
  }
  const salle = await salleAutorisee(s.salle, userId);
  return { session: s, salle };
}
