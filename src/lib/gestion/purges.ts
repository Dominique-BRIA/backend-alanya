import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { purgerVuesUniques } from "@/modules/messaging/vue-unique";
import { effacerDefinitivement } from "@/modules/media/storage";
import { ErreurAdmin } from "./reponses";
import { auteur, ecrireReglage, lireReglage } from "./outils";
import { type SessionAdmin } from "./session";

/**
 * LES PURGES DE RÉTENTION, pilotées depuis la console (16/10/2026).
 *
 * Chaque purge dit ce qu'elle effacerait MAINTENANT (`stats`) avant qu'on la
 * lance, garde la trace de chacun de ses passages (`gestion_purge_passage`),
 * et tourne d'elle-même une fois par jour si elle est activée.
 *
 * ⚠️ AUCUNE NE TOUCHE AUX MESSAGES. Effacer des conversations est une
 * décision trop lourde pour un réglage : la console ne le propose pas.
 */

interface Bouton {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  defaut: number;
}

interface Purge {
  name: string;
  label: string;
  description: string;
  boutons: Bouton[];
  activeParDefaut: boolean;
  /** Ce qui serait effacé maintenant. */
  volumes: (o: Record<string, number>) => Promise<Record<string, unknown>>;
  executer: (o: Record<string, number>) => Promise<Record<string, unknown>>;
}

const ilYA = (n: number, unite: "jours" | "heures") => new Date(Date.now() - n * (unite === "jours" ? 86_400_000 : 3_600_000));

const PURGES: Purge[] = [
  {
    name: "statuts",
    label: "Statuts expirés",
    description: "Efface les statuts expirés (et leurs fichiers) après un délai de grâce.",
    boutons: [{ key: "joursApresExpiration", label: "Délai après expiration", unit: "jours", min: 0, max: 30, defaut: 1 }],
    activeParDefaut: true,
    volumes: async (o) => ({ statuts: await prisma.status.count({ where: { expiresAt: { lt: ilYA(o.joursApresExpiration, "jours") } } }) }),
    executer: async (o) => {
      const cibles = await prisma.status.findMany({
        where: { expiresAt: { lt: ilYA(o.joursApresExpiration, "jours") } },
        select: { id: true, mediaUrl: true },
        take: 5000,
      });
      // Les fichiers d'abord : une fois la ligne partie, plus rien ne les désigne.
      let fichiers = 0;
      for (const s of cibles) {
        if (s.mediaUrl && !/^https?:\/\//.test(s.mediaUrl)) {
          await effacerDefinitivement(s.mediaUrl).catch(() => {});
          fichiers++;
        }
      }
      const r = await prisma.status.deleteMany({ where: { id: { in: cibles.map((s) => s.id) } } });
      return { statuts: r.count, fichiers };
    },
  },
  {
    name: "vues-uniques",
    label: "Médias à vue unique",
    description: "Efface les médias à vue unique déjà ouverts, ou jamais ouverts depuis 14 jours.",
    boutons: [],
    activeParDefaut: true,
    volumes: async () => ({}),
    executer: async () => ({ fichiers: await purgerVuesUniques() }),
  },
  {
    name: "journal-audit",
    label: "Journal d'audit",
    description: "Efface les lignes du journal d'audit de la console plus anciennes que le délai.",
    boutons: [{ key: "jours", label: "Conserver", unit: "jours", min: 30, max: 3650, defaut: 365 }],
    activeParDefaut: false,
    volumes: async (o) => ({ lignes: await prisma.gestionAudit.count({ where: { creeLe: { lt: ilYA(o.jours, "jours") } } }) }),
    executer: async (o) => ({ lignes: (await prisma.gestionAudit.deleteMany({ where: { creeLe: { lt: ilYA(o.jours, "jours") } } })).count }),
  },
  {
    name: "diffusions",
    label: "Historique des diffusions",
    description: "Efface les diffusions terminées ou annulées (et leur détail par destinataire) plus anciennes que le délai. Les messages reçus restent.",
    boutons: [{ key: "jours", label: "Conserver", unit: "jours", min: 30, max: 3650, defaut: 180 }],
    activeParDefaut: false,
    volumes: async (o) => ({
      diffusions: await prisma.diffusion.count({ where: { statut: { in: ["terminee", "annulee", "echec"] }, creeLe: { lt: ilYA(o.jours, "jours") } } }),
    }),
    executer: async (o) => ({
      diffusions: (
        await prisma.diffusion.deleteMany({ where: { statut: { in: ["terminee", "annulee", "echec"] }, creeLe: { lt: ilYA(o.jours, "jours") } } })
      ).count,
    }),
  },
  {
    name: "trajets-points",
    label: "Positions des trajets",
    description: "Efface les positions GPS des trajets clos depuis plus que le délai ; le trajet lui-même reste, sans trace.",
    boutons: [{ key: "heures", label: "Conserver après clôture", unit: "heures", min: 1, max: 720, defaut: 72 }],
    activeParDefaut: true,
    volumes: async (o) => ({
      points: await prisma.trajetPoint.count({ where: { trajet: { statut: "clos", closLe: { lt: ilYA(o.heures, "heures") } } } }),
    }),
    executer: async (o) => purgerPointsTrajets(ilYA(o.heures, "heures")),
  },
];

/** Efface les positions des trajets clos avant `avant`. Partagé avec l'écran des trajets. */
export async function purgerPointsTrajets(avant: Date) {
  const trajets = await prisma.trajet.findMany({
    where: { statut: "clos", closLe: { lt: avant }, pointsPurges: false },
    select: { id: true },
  });
  const ids = trajets.map((t) => t.id);
  const points = await prisma.trajetPoint.deleteMany({ where: { trajetId: { in: ids } } });
  await prisma.trajet.updateMany({ where: { id: { in: ids } }, data: { pointsPurges: true } });
  return { points: points.count, trajets: ids.length };
}

const CLE = "purges";
type Reglages = Record<string, { enabled?: boolean; overrides?: Record<string, number> }>;

function trouver(nom: string) {
  const p = PURGES.find((x) => x.name === nom);
  if (!p) throw new ErreurAdmin(404, "Purge inconnue", "PURGE_NOT_FOUND");
  return p;
}

function options(p: Purge, r: Reglages) {
  const surcharges = r[p.name]?.overrides ?? {};
  return Object.fromEntries(p.boutons.map((b) => [b.key, surcharges[b.key] ?? b.defaut])) as Record<string, number>;
}

async function presenter(p: Purge, r: Reglages, meta: { modifieLe: Date | null; modifiePar: string | null }) {
  const opts = options(p, r);
  let stats: Record<string, unknown> | null = null;
  let statsErreur: string | null = null;
  try {
    stats = await p.volumes(opts);
  } catch (e) {
    statsErreur = String((e as Error)?.message ?? e);
  }
  const passages = await prisma.gestionPurgePassage.findMany({ where: { nom: p.name }, orderBy: { lanceLe: "desc" }, take: 10 });
  return {
    name: p.name,
    label: p.label,
    description: p.description,
    enabled: r[p.name]?.enabled ?? p.activeParDefaut,
    options: opts,
    defauts: Object.fromEntries(p.boutons.map((b) => [b.key, b.defaut])),
    surcharges: r[p.name]?.overrides ?? {},
    knobs: p.boutons.map((b) => ({ ...b, valeur: opts[b.key] })),
    stats,
    statsErreur,
    runs: passages.map(presenterPassage),
    updatedAt: meta.modifieLe,
    updatedBy: meta.modifiePar,
  };
}

function presenterPassage(x: Prisma.GestionPurgePassageGetPayload<object>) {
  return {
    id: Number(x.id),
    name: x.nom,
    ranAt: x.lanceLe,
    triggerSource: x.declencheur,
    byAdmin: x.parAdmin,
    ok: x.ok ? 1 : 0,
    result: x.resultat,
    error: x.erreur,
    durationMs: x.dureeMs,
  };
}

export async function listerPurges() {
  const r = await lireReglage<Reglages>(CLE, {});
  return Promise.all(PURGES.map((p) => presenter(p, r.valeur, r)));
}

export async function reglerPurge(nom: string, brut: unknown, session: SessionAdmin) {
  const p = trouver(nom);
  const corps = (brut ?? {}) as { enabled?: unknown; overrides?: Record<string, unknown> };
  const r = await lireReglage<Reglages>(CLE, {});
  const actuel = r.valeur[nom] ?? {};
  const surcharges = { ...(actuel.overrides ?? {}) };
  for (const [cle, v] of Object.entries(corps.overrides ?? {})) {
    const b = p.boutons.find((x) => x.key === cle);
    if (!b) throw new ErreurAdmin(400, `Réglage inconnu : ${cle}`, "VALIDATION");
    if (v === null) {
      delete surcharges[cle];
      continue;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < b.min || n > b.max) {
      throw new ErreurAdmin(400, `${b.label} : entre ${b.min} et ${b.max} ${b.unit}`, "VALIDATION");
    }
    surcharges[cle] = Math.round(n);
  }
  const nouveau = { ...r.valeur, [nom]: { enabled: typeof corps.enabled === "boolean" ? corps.enabled : actuel.enabled, overrides: surcharges } };
  const ecrit = await ecrireReglage(CLE, nouveau, session);
  return presenter(p, nouveau, ecrit);
}

/** Lance une purge et garde la trace du passage, réussi ou non. */
async function executer(p: Purge, declencheur: "auto" | "manual", parAdmin: string | null) {
  const r = await lireReglage<Reglages>(CLE, {});
  const debut = Date.now();
  let ok = true;
  let resultat: Record<string, unknown> | null = null;
  let erreur: string | null = null;
  try {
    resultat = await p.executer(options(p, r.valeur));
  } catch (e) {
    ok = false;
    erreur = String((e as Error)?.message ?? e).slice(0, 2000);
  }
  await prisma.gestionPurgePassage.create({
    data: {
      nom: p.name,
      declencheur,
      parAdmin,
      ok,
      resultat: (resultat ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      erreur,
      dureeMs: Date.now() - debut,
    },
  });
  return ok;
}

export async function lancerPurge(nom: string, session: SessionAdmin) {
  const p = trouver(nom);
  const ok = await executer(p, "manual", auteur(session));
  const passages = await prisma.gestionPurgePassage.findMany({ where: { nom }, orderBy: { lanceLe: "desc" }, take: 10 });
  return { ok, runs: passages.map(presenterPassage) };
}

/** Appelée chaque heure : chaque purge activée tourne si son dernier passage automatique a plus d'un jour. */
export async function purgesAutomatiques() {
  const r = await lireReglage<Reglages>(CLE, {});
  for (const p of PURGES) {
    if (!(r.valeur[p.name]?.enabled ?? p.activeParDefaut)) continue;
    const dernier = await prisma.gestionPurgePassage.findFirst({
      where: { nom: p.name, declencheur: "auto" },
      orderBy: { lanceLe: "desc" },
      select: { lanceLe: true },
    });
    if (dernier && Date.now() - dernier.lanceLe.getTime() < 23 * 3_600_000) continue;
    await executer(p, "auto", null);
  }
}

/** Le dernier passage de chaque purge — pour l'écran « santé ». */
export async function derniersPassages() {
  return Promise.all(
    PURGES.map(async (p) => {
      const d = await prisma.gestionPurgePassage.findFirst({ where: { nom: p.name }, orderBy: { lanceLe: "desc" } });
      return {
        name: p.name,
        dernierPassage: d?.lanceLe ?? null,
        ok: d ? d.ok : null,
        erreur: d?.erreur ?? null,
        dureeMs: d?.dureeMs ?? null,
        declencheur: d?.declencheur ?? null,
      };
    }),
  );
}
