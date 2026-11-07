import { prisma } from "@/lib/prisma";

/**
 * UNE SALLE SFU (07/11/2026) : un appel de groupe (`call:<uuid>`) ou une
 * réunion (`meeting:<id>`) dont le moteur est le SFU.
 *
 * 🔴 TOUTE ROUTE `/api/sfu/...` COMMENCE PAR [participantActif]. C'est le seul
 * garde-fou entre un compte quelconque et la session Cloudflare d'un appel :
 * sans lui, connaître l'identifiant d'une réunion suffirait à en recevoir le
 * son et l'image.
 */
export type Salle = { genre: "call"; id: string } | { genre: "meeting"; id: number };

/**
 * L'APPAREIL qui fait cette requête sait-il rejoindre une salle SFU ? Les
 * versions à jour du mobile et du web envoient `X-Alanya-Capacites: sfu`
 * quand elles décrochent ou entrent en réunion ; les anciennes, rien.
 */
export function appareilSaitLeSfu(req: { headers: { get(nom: string): string | null } }): boolean {
  return (req.headers.get("x-alanya-capacites") ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .includes("sfu");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function lireSalle(brut: unknown): Salle | null {
  if (typeof brut !== "string") return null;
  const [genre, id] = brut.split(":");
  if (genre === "call" && id && UUID.test(id)) return { genre: "call", id: id.toLowerCase() };
  if (genre === "meeting" && /^\d{1,9}$/.test(id ?? "")) {
    const n = Number(id);
    if (n > 0) return { genre: "meeting", id: n };
  }
  return null;
}

export function cleSalle(s: Salle): string {
  return `${s.genre}:${s.id}`;
}

/**
 * [userId] est-il dans cette salle, qui est bien en SFU et pas terminée ?
 *
 * - Appel : participant sans départ noté, appel en sonnerie ou en cours.
 * - Réunion : organisateur, ou invité qui n'a pas décliné ; réunion ouverte.
 */
export async function participantActif(salle: Salle, userId: string): Promise<boolean> {
  if (salle.genre === "call") {
    const p = await prisma.callParticipant.findUnique({
      where: { callId_userId: { callId: salle.id, userId } },
      select: { leftAt: true, call: { select: { status: true, moteur: true } } },
    });
    return (
      !!p &&
      p.leftAt === null &&
      p.call.moteur === "sfu" &&
      (p.call.status === "RINGING" || p.call.status === "ONGOING")
    );
  }
  const m = await prisma.meeting.findUnique({
    where: { idMeeting: salle.id },
    select: { isEnd: true, moteur: true, idOrganiser: true },
  });
  if (!m || m.isEnd === 1 || m.moteur !== "sfu") return false;
  if (m.idOrganiser === userId) return true;
  const p = await prisma.meetingParticipant.findUnique({
    where: { idMeeting_IDparticipant: { idMeeting: salle.id, IDparticipant: userId } },
    select: { status: true },
  });
  return !!p && p.status !== 2;
}

/** Les comptes à prévenir quand quelqu'un publie dans la salle. */
export async function membresDeLaSalle(salle: Salle): Promise<string[]> {
  if (salle.genre === "call") {
    const ps = await prisma.callParticipant.findMany({
      where: { callId: salle.id, leftAt: null },
      select: { userId: true },
    });
    return ps.map((p) => p.userId);
  }
  const [m, ps] = await Promise.all([
    prisma.meeting.findUnique({ where: { idMeeting: salle.id }, select: { idOrganiser: true } }),
    prisma.meetingParticipant.findMany({
      where: { idMeeting: salle.id, status: { not: 2 } },
      select: { IDparticipant: true },
    }),
  ]);
  return [...new Set([...(m ? [m.idOrganiser] : []), ...ps.map((p) => p.IDparticipant)])];
}
