import { prisma } from "@/lib/prisma";
import { nomAffichage } from "@/lib/display-name.mjs";
import { serieJours, type periode } from "./outils";

/**
 * LES STATISTIQUES DE LA CONSOLE (tableau de bord, analyses), 16/10/2026.
 *
 * Des VOLUMES, jamais un contenu : on compte des messages, on ne les lit pas
 * (et ceux des fils chiffrés seraient illisibles de toute façon).
 *
 * ⚠️ LES REGROUPEMENTS PAR JOUR SONT EN SQL BRUT, avec les noms de colonnes
 * RÉELS de la base partagée (`message."sendAt"`, `users."created_at"`…) :
 * Prisma ne sait pas grouper par date. Un `@map` qui changerait dans le
 * schéma doit être reporté ici.
 */

type Periode = ReturnType<typeof periode>;

const parJour = (lignes: { d: Date | string; n: bigint | number }[]) =>
  new Map(lignes.map((l) => [new Date(l.d).toISOString().slice(0, 10), Number(l.n)]));

const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : 0);

/* ══════════════ Tableau de bord ══════════════ */

export async function tableauDeBord(p: Periode) {
  const [totalUsers, onlineUsers, bannedUsers, messagesPeriod, callsPeriod, statusesPeriod, inscriptions, activite, pays, top] =
    await Promise.all([
      prisma.user.count({ where: { isDelete: false } }),
      prisma.user.count({ where: { isDelete: false, isOnline: 1 } }),
      prisma.user.count({ where: { isDelete: false, exclus: 1 } }),
      prisma.message.count({ where: { createdAt: { gte: p.from, lte: p.to } } }),
      prisma.call.count({ where: { startedAt: { gte: p.from, lte: p.to } } }),
      prisma.status.count({ where: { createdAt: { gte: p.from, lte: p.to } } }),
      prisma.$queryRaw<{ d: Date; n: bigint }[]>`
        SELECT date_trunc('day', "created_at") AS d, count(*) AS n FROM "users"
         WHERE "created_at" BETWEEN ${p.from} AND ${p.to} GROUP BY 1`,
      prisma.$queryRaw<{ d: Date; n: bigint }[]>`
        SELECT date_trunc('day', "sendAt") AS d, count(*) AS n FROM "message"
         WHERE "sendAt" BETWEEN ${p.from} AND ${p.to} GROUP BY 1`,
      prisma.$queryRaw<{ pays: string; n: bigint }[]>`
        SELECT p."libelle" AS pays, count(*) AS n FROM "users" u JOIN "pays" p ON p."idPays" = u."idPays"
         WHERE u."isDelete" = false GROUP BY p."libelle" ORDER BY n DESC LIMIT 10`,
      prisma.$queryRaw<{ id: string; n: bigint }[]>`
        SELECT "senderID"::text AS id, count(*) AS n FROM "message"
         WHERE "sendAt" BETWEEN ${p.from} AND ${p.to} AND "type" <> 'SYSTEM'
         GROUP BY 1 ORDER BY n DESC LIMIT 10`,
    ]);
  const comptes = await prisma.user.findMany({
    where: { id: { in: top.map((t) => t.id) } },
    select: { id: true, nom: true, pseudo: true, avatarUrl: true, publicNumber: true },
  });
  const appels = await prisma.call.groupBy({
    by: ["initiatorId"],
    where: { initiatorId: { in: top.map((t) => t.id) }, startedAt: { gte: p.from, lte: p.to } },
    _count: { _all: true },
  });
  return {
    counters: { totalUsers, onlineUsers, bannedUsers, messagesPeriod, callsPeriod, statusesPeriod },
    registrations: serieJours(p.from, p.to, parJour(inscriptions)),
    activity: serieJours(p.from, p.to, parJour(activite)),
    topCountries: pays.map((x) => ({ pays: x.pays, users: Number(x.n) })),
    topUsers: top.map((t) => {
      const c = comptes.find((u) => u.id === t.id);
      return {
        alanyaID: t.id,
        nom: c ? (nomAffichage(c) ?? "") : "",
        pseudo: c?.pseudo ?? "",
        avatarUrl: c?.avatarUrl ?? "",
        messagesSent: Number(t.n),
        callsMade: appels.find((a) => a.initiatorId === t.id)?._count._all ?? 0,
        callsReceived: 0,
      };
    }),
  };
}

/* ══════════════ Analyses ══════════════ */

const LIBELLES_MESSAGES: Record<string, [number, string]> = {
  TEXT: [0, "Texte"],
  IMAGE: [1, "Image"],
  FILE: [2, "Fichier"],
  AUDIO: [3, "Vocal"],
  VIDEO: [4, "Vidéo"],
  SYSTEM: [5, "Système"],
  CONTACT: [6, "Contact"],
  LOCATION: [7, "Position"],
};
const LIBELLES_TYPES_COMPTE: Record<number, string> = {
  0: "Personne",
  2: "Agent",
  3: "Centre d'appels",
  4: "Centre vocal",
  5: "Officiel",
  9: "Modérateur",
};

async function appels(from: Date, to: Date) {
  const lignes = await prisma.call.groupBy({
    by: ["type", "status"],
    where: { startedAt: { gte: from, lte: to } },
    _count: { _all: true },
  });
  const n = (f: (l: (typeof lignes)[number]) => boolean) => lignes.filter(f).reduce((s, l) => s + l._count._all, 0);
  const total = n(() => true);
  const answered = n((l) => l.status === "ENDED" || l.status === "ONGOING");
  const [duree] = await prisma.$queryRaw<{ moy: number | null; somme: number | null }[]>`
    SELECT avg(extract(epoch FROM ("endedAt" - "answeredAt")))::float AS moy,
           sum(extract(epoch FROM ("endedAt" - "answeredAt")))::float AS somme
      FROM "calls" WHERE "startedAt" BETWEEN ${from} AND ${to}
       AND "answeredAt" IS NOT NULL AND "endedAt" IS NOT NULL`;
  return {
    total,
    audio: n((l) => l.type === "AUDIO"),
    video: n((l) => l.type === "VIDEO"),
    answered,
    missed: n((l) => l.status === "MISSED" || l.status === "NO_ANSWER"),
    rejected: n((l) => l.status === "REJECTED" || l.status === "BUSY"),
    voicemail: 0,
    voicemailAfterRing: 0,
    avgDuration: Math.round(duree?.moy ?? 0),
    totalDuration: Math.round(duree?.somme ?? 0),
    successRate: ratio(answered, total),
    relay: 0,
    p2p: 0,
    modeUnknown: total,
    relayRate: 0,
    p2pRate: 0,
  };
}

export async function analyses(p: Periode) {
  const { from, to } = p;
  const entre = { gte: from, lte: to };
  const [
    parType, parJourMessages, appelsJour, callStats, statuts, vues, reunions, participants, typesCompte,
    nouveaux, bannis, total, connexions, appareils, conv, groupes, membresGroupes, chaleur,
    precMessages, precAppels, precStatuts, precInscriptions,
  ] = await Promise.all([
    prisma.message.groupBy({ by: ["type"], where: { createdAt: entre }, _count: { _all: true } }),
    prisma.$queryRaw<{ d: Date; n: bigint }[]>`
      SELECT date_trunc('day', "sendAt") AS d, count(*) AS n FROM "message" WHERE "sendAt" BETWEEN ${from} AND ${to} GROUP BY 1`,
    prisma.$queryRaw<{ d: Date; audio: bigint; video: bigint }[]>`
      SELECT date_trunc('day', "startedAt") AS d,
             count(*) FILTER (WHERE "type" = 'AUDIO') AS audio,
             count(*) FILTER (WHERE "type" = 'VIDEO') AS video
        FROM "calls" WHERE "startedAt" BETWEEN ${from} AND ${to} GROUP BY 1`,
    appels(from, to),
    prisma.status.groupBy({ by: ["type"], where: { createdAt: entre }, _count: { _all: true } }),
    prisma.statusView.count({ where: { viewedAt: entre } }),
    prisma.meeting.findMany({ where: { start_time: entre }, select: { isEnd: true, duree: true, idOrganiser: true, idMeeting: true } }),
    prisma.meetingParticipant.findMany({
      where: { meeting: { start_time: entre } },
      select: { IDparticipant: true, idMeeting: true, start_time: true, duree: true },
    }),
    prisma.user.groupBy({ by: ["typeCompte"], where: { isDelete: false }, _count: { _all: true } }),
    prisma.user.count({ where: { isDelete: false, createdAt: entre } }),
    prisma.user.count({ where: { isDelete: false, exclus: 1 } }),
    prisma.user.count({ where: { isDelete: false } }),
    prisma.userAccess.groupBy({ by: ["osSystem"], where: { dateLogin: entre }, _count: { _all: true } }),
    prisma.appareil.groupBy({ by: ["system"], where: { destroy: 0, lastLogin: entre }, _count: { _all: true } }),
    prisma.conversation.count(),
    prisma.conversation.count({ where: { isGroup: true } }),
    prisma.participant.count({ where: { estMembre: true, conv: { isGroup: true } } }),
    prisma.$queryRaw<{ dow: number; hour: number; n: bigint }[]>`
      SELECT extract(dow FROM "sendAt")::int AS dow, extract(hour FROM "sendAt")::int AS hour, count(*) AS n
        FROM "message" WHERE "sendAt" BETWEEN ${from} AND ${to} GROUP BY 1, 2`,
    prisma.message.count({ where: { createdAt: { gte: p.prevFrom, lt: p.prevTo } } }),
    prisma.call.count({ where: { startedAt: { gte: p.prevFrom, lt: p.prevTo } } }),
    prisma.status.count({ where: { createdAt: { gte: p.prevFrom, lt: p.prevTo } } }),
    prisma.user.count({ where: { createdAt: { gte: p.prevFrom, lt: p.prevTo } } }),
  ]);

  const totalStatuts = statuts.reduce((s, x) => s + x._count._all, 0);
  const organisateurs = new Map(reunions.map((r) => [r.idMeeting, r.idOrganiser]));
  const invites = participants.filter((x) => organisateurs.get(x.idMeeting) !== x.IDparticipant);
  const venus = participants.filter((x) => x.start_time !== null);
  const invitesVenus = invites.filter((x) => x.start_time !== null);
  const durees = participants.map((x) => x.duree ?? 0).filter((d) => d > 0);

  return {
    messagesByType: parType.map((t) => ({
      type: LIBELLES_MESSAGES[t.type]?.[0] ?? 9,
      label: LIBELLES_MESSAGES[t.type]?.[1] ?? t.type,
      count: t._count._all,
    })),
    messagesByDay: serieJours(from, to, parJour(parJourMessages)),
    calls: callStats,
    callsByDay: serieJours(from, to, new Map()).map((j) => {
      const l = appelsJour.find((x) => new Date(x.d).toISOString().slice(0, 10) === j.date);
      return { date: j.date, audio: Number(l?.audio ?? 0), video: Number(l?.video ?? 0) };
    }),
    stories: {
      total: totalStatuts,
      totalViews: vues,
      totalLikes: 0,
      avgViews: totalStatuts ? Math.round((vues / totalStatuts) * 10) / 10 : 0,
      engagementRate: ratio(vues, totalStatuts),
      byType: statuts.map((s, i) => ({ type: i, label: s.type === "TEXT" ? "Texte" : s.type === "IMAGE" ? "Image" : "Vidéo", count: s._count._all })),
    },
    meetings: {
      total: reunions.length,
      ended: reunions.filter((r) => r.isEnd === 1).length,
      avgPlannedMinutes: reunions.length ? Math.round(reunions.reduce((s, r) => s + r.duree, 0) / reunions.length) : 0,
      avgRealDuration: durees.length ? Math.round(durees.reduce((s, d) => s + d, 0) / durees.length) : 0,
      participants: participants.length,
      attendees: venus.length,
      invitations: invites.length,
      joined: invitesVenus.length,
      invitedNeverJoined: invites.length - invitesVenus.length,
      attendanceRate: ratio(venus.length, participants.length),
      joinRate: ratio(invitesVenus.length, invites.length),
    },
    users: {
      byRole: typesCompte.map((t) => ({ role: t.typeCompte, label: LIBELLES_TYPES_COMPTE[t.typeCompte] ?? `Type ${t.typeCompte}`, count: t._count._all })),
      newUsers: nouveaux,
      bannedUsers: bannis,
      totalUsers: total,
    },
    devices: connexions.map((c) => ({ os: c.osSystem || "Inconnu", count: c._count._all })),
    activeDevices: appareils.map((a) => ({ os: a.system || "Inconnu", count: a._count._all })),
    conversations: {
      total: conv,
      groups: groupes,
      oneToOne: conv - groupes,
      avgGroupSize: groupes ? Math.round((membresGroupes / groupes) * 10) / 10 : 0,
    },
    heatmap: chaleur.map((c) => ({ dow: c.dow, hour: c.hour, count: Number(c.n) })),
    comparison: { messages: precMessages, calls: precAppels, statuses: precStatuts, registrations: precInscriptions },
    period: { from: from.toISOString(), to: to.toISOString() },
    previousPeriod: { from: p.prevFrom.toISOString(), to: p.prevTo.toISOString() },
  };
}

/* ══════════════ Fil d'activité ══════════════ */

/** Les derniers événements de la plateforme — des faits, jamais un contenu. */
export async function filActivite() {
  const [comptes, appelsRecents, reunions, statuts] = await Promise.all([
    prisma.user.findMany({ where: { isDelete: false }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, nom: true, pseudo: true, publicNumber: true, createdAt: true } }),
    prisma.call.findMany({ orderBy: { startedAt: "desc" }, take: 10, select: { id: true, type: true, startedAt: true, initiator: { select: { nom: true, pseudo: true, publicNumber: true } } } }),
    prisma.meeting.findMany({ orderBy: { start_time: "desc" }, take: 5, select: { idMeeting: true, objet: true, start_time: true, organiser: { select: { nom: true, pseudo: true, publicNumber: true } } } }),
    prisma.status.findMany({ orderBy: { createdAt: "desc" }, take: 5, select: { id: true, createdAt: true, user: { select: { nom: true, pseudo: true, publicNumber: true } } } }),
  ]);
  const nom = (u: { nom: string | null; pseudo: string | null; publicNumber: string } | null) => (u ? (nomAffichage(u) ?? "") : "");
  return [
    ...comptes.map((u) => ({ id: `u-${u.id}`, type: "user_joined", user: nom(u), detail: "Nouveau compte", time: u.createdAt })),
    ...appelsRecents.map((c) => ({ id: `c-${c.id}`, type: "call", user: nom(c.initiator), detail: c.type === "VIDEO" ? "Appel vidéo" : "Appel audio", time: c.startedAt })),
    ...reunions.map((r) => ({ id: `m-${r.idMeeting}`, type: "meeting", user: nom(r.organiser), detail: r.objet, time: r.start_time })),
    ...statuts.map((s) => ({ id: `s-${s.id}`, type: "status", user: nom(s.user), detail: "Nouveau statut", time: s.createdAt })),
  ]
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, 30);
}
