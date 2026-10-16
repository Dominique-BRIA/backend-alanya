import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ErreurAdmin } from "./reponses";
import { auteur, lireReglage, serieJours, type periode } from "./outils";
import { purgerPointsTrajets } from "./purges";
import { type SessionAdmin } from "./session";

/**
 * LES TRAJETS DE CONFIANCE (16/10/2026).
 *
 * Un utilisateur annonce un trajet (taxi, marche, ou SOS) avec une durée ;
 * son téléphone envoie ses positions ; il confirme son arrivée, prolonge, ou
 * déclenche une alerte. L'application s'y branchera à l'étape mobile.
 *
 * 🔴 LA CONSOLE NE VOIT AUCUN TRAJET NOMMÉ : des volumes, des durées, des
 * taux — jamais une personne ni une position. Les positions sont la donnée la
 * plus sensible de l'application ; elles sont effacées après la clôture
 * (rétention réglable, purge automatique `trajets-points`).
 */

type Periode = ReturnType<typeof periode>;
const NATURES = ["taxi", "walk", "sos"] as const;
const POLITIQUE = { pointsHours: 72, pointsIncidentDays: 30, tripMonths: 12 };

const mediane = (v: number[], q = 0.5) => {
  if (!v.length) return 0;
  const t = [...v].sort((a, b) => a - b);
  return Math.round(t[Math.min(t.length - 1, Math.floor(q * t.length))]);
};
const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : 0);

export async function statistiques(p: Periode) {
  const [periodeCourante, precedente, ouverts, clos] = await Promise.all([
    prisma.trajet.findMany({ where: { demarreLe: { gte: p.from, lte: p.to } } }),
    prisma.trajet.count({ where: { demarreLe: { gte: p.prevFrom, lt: p.prevTo } } }),
    prisma.trajet.count({ where: { statut: { in: ["ouvert", "alerte"] } } }),
    prisma.trajet.findMany({ where: { closLe: { gte: p.from, lte: p.to } } }),
  ]);
  const parJour = new Map<string, number>();
  for (const t of periodeCourante) {
    const j = t.demarreLe.toISOString().slice(0, 10);
    parJour.set(j, (parJour.get(j) ?? 0) + 1);
  }
  const durees = clos.filter((t) => t.closLe).map((t) => (t.closLe!.getTime() - t.demarreLe.getTime()) / 1000);
  const alertes = periodeCourante.filter((t) => t.alerteLe);
  const resolues = alertes.filter((t) => t.alerteResolueLe);
  const raisons = new Map<string, number>();
  for (const t of clos) raisons.set(t.raisonCloture ?? "inconnue", (raisons.get(t.raisonCloture ?? "inconnue") ?? 0) + 1);
  return {
    openNow: ouverts,
    started: periodeCourante.length,
    startedPrevious: precedente,
    startedByDay: serieJours(p.from, p.to, parJour),
    confirmed: periodeCourante.filter((t) => t.confirme).length,
    confirmedRate: ratio(periodeCourante.filter((t) => t.confirme).length, periodeCourante.length),
    alerted: alertes.length,
    alertedRate: ratio(alertes.length, periodeCourante.length),
    sos: periodeCourante.filter((t) => t.nature === "sos").length,
    closed: clos.length,
    durationMedianSec: mediane(durees),
    durationP90Sec: mediane(durees, 0.9),
    avgExtensions: periodeCourante.length
      ? Math.round((periodeCourante.reduce((s, t) => s + t.prolongations, 0) / periodeCourante.length) * 10) / 10
      : 0,
    alertsClosed: alertes.filter((t) => t.statut === "clos").length,
    alertsResolved: resolues.length,
    alertsResolvedMedianSec: mediane(resolues.map((t) => (t.alerteResolueLe!.getTime() - t.alerteLe!.getTime()) / 1000)),
    byKind: NATURES.map((kind) => ({ kind, count: periodeCourante.filter((t) => t.nature === kind).length })),
    byCloseReason: [...raisons].map(([reason, count]) => ({ reason, count })),
    period: { from: p.from.toISOString(), to: p.to.toISOString() },
    previousPeriod: { from: p.prevFrom.toISOString(), to: p.prevTo.toISOString() },
  };
}

async function politique() {
  return (await lireReglage("trajets.retention", POLITIQUE)).valeur;
}

export async function retention() {
  const pol = await politique();
  const limitePoints = new Date(Date.now() - pol.pointsHours * 3_600_000);
  const limiteTrajets = new Date(Date.now() - pol.tripMonths * 30 * 86_400_000);
  const [points, trajets, ancien, ptsExpires, trajetsExpires, ptsClos, trajetsClos, purges, passages] = await Promise.all([
    prisma.trajetPoint.count(),
    prisma.trajet.count(),
    prisma.trajetPoint.findFirst({ orderBy: { releveLe: "asc" }, select: { releveLe: true } }),
    prisma.trajetPoint.count({ where: { trajet: { statut: "clos", closLe: { lt: limitePoints }, alerteLe: null } } }),
    prisma.trajet.count({ where: { statut: "clos", closLe: { lt: limiteTrajets } } }),
    prisma.trajetPoint.count({ where: { trajet: { statut: "clos" } } }),
    prisma.trajet.count({ where: { statut: "clos", pointsPurges: false } }),
    prisma.trajet.count({ where: { pointsPurges: true } }),
    prisma.gestionPurgePassage.findMany({ where: { nom: "trajets" }, orderBy: { lanceLe: "desc" }, take: 10 }),
  ]);
  const runs = passages.map((x) => {
    const r = (x.resultat ?? {}) as { scope?: string; points?: number; trajets?: number };
    return { at: x.lanceLe, scope: r.scope === "all" ? "all" : "retention", by: x.parAdmin, points: r.points ?? 0, trips: r.trajets ?? 0 };
  });
  return {
    policy: pol,
    stored: { points, trips: trajets, oldestPointAt: ancien?.releveLe ?? null },
    expired: { points: ptsExpires, trips: trajetsExpires },
    closed: { points: ptsClos, trips: trajetsClos },
    purgedTrips: purges,
    runs,
    lastRun: runs[0],
  };
}

/** `retention` : la politique ; `all` : toutes les positions des trajets clos. */
export async function purger(scope: string, session: SessionAdmin) {
  if (scope !== "retention" && scope !== "all") throw new ErreurAdmin(400, "Portée inconnue", "VALIDATION");
  const pol = await politique();
  const debut = Date.now();
  let resultat: { points: number; trajets: number };
  if (scope === "all") {
    resultat = await purgerPointsTrajets(new Date());
  } else {
    const r = await purgerPointsTrajets(new Date(Date.now() - pol.pointsHours * 3_600_000));
    const vieux = await prisma.trajet.deleteMany({
      where: { statut: "clos", closLe: { lt: new Date(Date.now() - pol.tripMonths * 30 * 86_400_000) } },
    });
    resultat = { points: r.points, trajets: r.trajets + vieux.count };
  }
  await prisma.gestionPurgePassage.create({
    data: { nom: "trajets", declencheur: "manual", parAdmin: auteur(session), ok: true, resultat: { scope, ...resultat }, dureeMs: Date.now() - debut },
  });
  return retention();
}

/* ══════════════ Côté application ══════════════ */

const demarrageSchema = z.object({
  nature: z.enum(NATURES),
  dureeMinutes: z.coerce.number().int().min(5).max(24 * 60).optional(),
});

export async function demarrer(userId: string, brut: unknown) {
  const c = demarrageSchema.parse(brut);
  try {
    const t = await prisma.trajet.create({
      data: {
        userId,
        nature: c.nature,
        // Un SOS est une alerte dès sa naissance.
        statut: c.nature === "sos" ? "alerte" : "ouvert",
        alerteLe: c.nature === "sos" ? new Date() : null,
        echeance: c.dureeMinutes ? new Date(Date.now() + c.dureeMinutes * 60_000) : null,
      },
    });
    return presenterTrajet(t);
  } catch (e) {
    // L'index unique partiel : un seul trajet ouvert par compte.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ErreurAdmin(409, "Un trajet est déjà en cours", "TRIP_ALREADY_OPEN");
    }
    throw e;
  }
}

function presenterTrajet(t: Prisma.TrajetGetPayload<object>) {
  return {
    id: Number(t.id),
    nature: t.nature,
    statut: t.statut,
    demarreLe: t.demarreLe,
    echeance: t.echeance,
    prolongations: t.prolongations,
    alerteLe: t.alerteLe,
    closLe: t.closLe,
  };
}

export async function trajetActif(userId: string) {
  const t = await prisma.trajet.findFirst({ where: { userId, statut: { in: ["ouvert", "alerte"] } } });
  return t ? presenterTrajet(t) : null;
}

const pointsSchema = z.object({
  points: z
    .array(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), precision: z.number().min(0).max(10_000).optional(), at: z.string().datetime({ offset: true }).optional() }))
    .min(1)
    .max(200),
});
const prolongationSchema = z.object({ minutes: z.coerce.number().int().min(5).max(240) });

/** Une action sur SON trajet en cours : points, prolonger, arrive, alerte, resolu, cloturer. */
export async function agir(userId: string, id: bigint, action: string, brut: unknown) {
  const t = await prisma.trajet.findFirst({ where: { id, userId } });
  if (!t) throw new ErreurAdmin(404, "Trajet introuvable", "TRIP_NOT_FOUND");
  if (t.statut === "clos") throw new ErreurAdmin(409, "Ce trajet est clos", "TRIP_CLOSED");
  const maintenant = new Date();
  switch (action) {
    case "points": {
      const c = pointsSchema.parse(brut);
      await prisma.trajetPoint.createMany({
        data: c.points.map((x) => ({ trajetId: id, lat: x.lat, lng: x.lng, precisionM: x.precision ?? null, releveLe: x.at ? new Date(x.at) : maintenant })),
      });
      return { ok: true, recus: c.points.length };
    }
    case "prolonger": {
      const c = prolongationSchema.parse(brut);
      const base = t.echeance && t.echeance > maintenant ? t.echeance : maintenant;
      const r = await prisma.trajet.update({ where: { id }, data: { echeance: new Date(base.getTime() + c.minutes * 60_000), prolongations: { increment: 1 } } });
      return presenterTrajet(r);
    }
    case "arrive":
      return presenterTrajet(await prisma.trajet.update({ where: { id }, data: { statut: "clos", confirme: true, closLe: maintenant, raisonCloture: "arrive" } }));
    case "alerte":
      return presenterTrajet(await prisma.trajet.update({ where: { id }, data: { statut: "alerte", alerteLe: t.alerteLe ?? maintenant } }));
    case "resolu":
      if (!t.alerteLe) throw new ErreurAdmin(409, "Aucune alerte en cours", "NO_ALERT");
      return presenterTrajet(await prisma.trajet.update({ where: { id }, data: { statut: "ouvert", alerteResolueLe: maintenant } }));
    case "cloturer": {
      const raison = String((brut as { raison?: unknown })?.raison ?? "annule").slice(0, 30);
      return presenterTrajet(await prisma.trajet.update({ where: { id }, data: { statut: "clos", closLe: maintenant, raisonCloture: raison } }));
    }
    default:
      throw new ErreurAdmin(404, "Action inconnue", "NOT_FOUND");
  }
}
