import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { creerMessage } from "@/modules/messaging/envoi";
import { findOrCreateDirectConversation } from "@/modules/messaging/access";
import { livrerMessagesOfficiels } from "@/lib/salle-temps-reel";
import { TYPE_COMPTE_OFFICIEL } from "@/lib/compte-officiel.mjs";
import { idCompteOfficielRequis } from "./compte-officiel";
import { copieDuMedia, mediaDeConsole } from "./medias";
import { languesManquantes, LANGUES_CONTENU, nettoyerTraductions, texteDans, type Traductions } from "./langues-contenu";
import { ErreurAdmin } from "./reponses";
import { auteurId, type SessionAdmin } from "./session";

/**
 * LES DIFFUSIONS DU COMPTE OFFICIEL (console de gestion, lot 1b, 16/10/2026).
 *
 * Le superroot écrit à une population choisie par critères ; chaque
 * destinataire reçoit un message ORDINAIRE d'« Alanya Work » dans son
 * tête-à-tête avec lui, par `creerMessage` — le même cœur d'envoi que tout le
 * reste, donc les mêmes gardes (blocage, longueur, aperçu de la liste).
 *
 * ── LE CHEMIN D'UNE DIFFUSION ───────────────────────────────────────────
 *
 *   1. `creerDiffusion` l'enregistre (`planifiee`), à échéance immédiate ou
 *      fixée. Rien n'est envoyé dans la requête : à 90 comptes ce serait
 *      supportable, à 50 000 la console attendrait une minute et repartirait.
 *   2. `traiterDiffusionsDues` la prend — juste après la réponse (`after`)
 *      pour une diffusion immédiate, sinon au tour de la boucle de fond
 *      (`src/instrumentation.ts`, toutes les 30 s).
 *   3. Chaque destinataire RÉSERVE sa ligne dans `diffusion_envoi` AVANT
 *      qu'on lui écrive. 🔴 C'EST CE QUI REND LA REPRISE SÛRE : un processus
 *      redémarré au milieu laisse expirer son verrou, le tour suivant reprend,
 *      et la clé (diffusion, destinataire) l'empêche de réécrire à qui a déjà
 *      reçu. Un envoi interrompu entre la réservation et l'écriture n'est pas
 *      refait : mieux vaut un message manquant qu'un message en double.
 *   4. La livraison en direct (trame + push) passe par le pont interne,
 *      par paquets — voir `livrerMessagesOfficiels`.
 *
 * ── CE QUI PART (24/10/2026, comme chez Alanya2026) ─────────────────────
 *
 * Un texte, une image ou une vidéo légendée, rédigés en français, anglais
 * (requis) et chinois ; chacun reçoit sa langue (repli anglais, puis
 * français). `kind` 1 : la diffusion part en STATUT de 24 h du compte
 * officiel — un statut par langue, et chaque destinataire touché reçoit une
 * ligne de `gestion_statut_destinataire` vers celui de sa langue.
 *
 * ── LES CRITÈRES ────────────────────────────────────────────────────────
 *
 * La grammaire de la console d'origine — `{ v: 1, op: "and", conditions }` —
 * avec NOS champs : pays, entreprise, type de compte, inscription, dernière
 * activité. Genre, âge et ville n'existent pas dans notre base. Les dates
 * relatives (`{ relative: "-30 days" }`) sont GELÉES à la création : on
 * envoie à ceux qu'on a comptés, pas à ceux d'une autre date.
 */

const MAX_CONDITIONS = 20;
const MAX_IDS = 500;
export const CONTENU_MAX = 4000;
/// Au-delà, la planification est sans doute une faute de frappe sur l'année.
const PLANIFICATION_MAX_JOURS = 90;
/// Durée du verrou d'un tour, renouvelée en cours de route.
const VERROU = "2 minutes";

const CHAMPS = ["idPays", "idCompany", "type_compte", "created_at", "last_seen"] as const;
type Champ = (typeof CHAMPS)[number];
const CHAMPS_DATES: ReadonlySet<Champ> = new Set(["created_at", "last_seen"]);

const dateSchema = z.union([
  z.string().datetime({ offset: true }),
  z.object({ absolute: z.string().datetime({ offset: true }) }),
  z.object({ relative: z.string().regex(/^-?\d+\s*(day|days|hour|hours)$/i) }),
]);

const conditionSchema = z
  .object({
    field: z.enum(CHAMPS),
    op: z.enum(["eq", "in", "before", "after", "between"]),
    value: z.unknown(),
  })
  .superRefine((c, ctx) => {
    const estDate = CHAMPS_DATES.has(c.field);
    const valide = estDate
      ? (c.op === "before" || c.op === "after") ? dateSchema.safeParse(c.value).success
        : c.op === "between" ? z.tuple([dateSchema, dateSchema]).safeParse(c.value).success
        : false
      : c.op === "eq" ? z.number().int().safeParse(c.value).success
        : c.op === "in" ? z.array(z.number().int()).min(1).max(MAX_IDS).safeParse(c.value).success
        : false;
    if (!valide) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Condition invalide sur ${c.field}` });
  });

export const criteresSchema = z.object({
  v: z.literal(1),
  op: z.literal("and"),
  conditions: z.array(conditionSchema).max(MAX_CONDITIONS),
});
export type Criteres = z.infer<typeof criteresSchema>;

function enDate(v: unknown, maintenant: Date): Date {
  if (typeof v === "string") return new Date(v);
  const o = v as { absolute?: string; relative?: string };
  if (o.absolute) return new Date(o.absolute);
  const m = /^(-?\d+)\s*(day|days|hour|hours)$/i.exec(o.relative ?? "")!;
  const d = new Date(maintenant);
  if (m[2].toLowerCase().startsWith("hour")) d.setHours(d.getHours() + Number(m[1]));
  else d.setDate(d.getDate() + Number(m[1]));
  return d;
}

/** Remplace chaque date relative par sa valeur à `maintenant`. */
export function gelerCriteres(criteres: Criteres, maintenant = new Date()): Criteres {
  return {
    ...criteres,
    conditions: criteres.conditions.map((c) => {
      if (!CHAMPS_DATES.has(c.field)) return c;
      const absolu = (v: unknown) => ({ absolute: enDate(v, maintenant).toISOString() });
      return { ...c, value: Array.isArray(c.value) ? c.value.map(absolu) : absolu(c.value) };
    }),
  };
}

/**
 * Les destinataires possibles, avant tout critère : les comptes vivants, sauf
 * le compte officiel lui-même. `exclus` = banni, `actif = 0` = désactivé.
 */
const BASE: Prisma.UserWhereInput = {
  isDelete: false,
  exclus: 0,
  actif: 1,
  typeCompte: { not: TYPE_COMPTE_OFFICIEL },
};

const COLONNE: Record<Champ, "idPays" | "idCompany" | "typeCompte" | "createdAt" | "lastSeen"> = {
  idPays: "idPays",
  idCompany: "idCompany",
  type_compte: "typeCompte",
  created_at: "createdAt",
  last_seen: "lastSeen",
};

/** Traduit des critères GELÉS en filtre Prisma. */
export function filtreDepuisCriteres(criteres: Criteres): Prisma.UserWhereInput {
  const maintenant = new Date();
  const et: Prisma.UserWhereInput[] = [BASE];
  for (const c of criteres.conditions) {
    const col = COLONNE[c.field];
    let filtre: unknown;
    if (c.op === "eq") filtre = c.value;
    else if (c.op === "in") filtre = { in: c.value };
    else if (c.op === "before") filtre = { lt: enDate(c.value, maintenant) };
    else if (c.op === "after") filtre = { gt: enDate(c.value, maintenant) };
    else {
      const [de, a] = c.value as unknown[];
      filtre = { gte: enDate(de, maintenant), lte: enDate(a, maintenant) };
    }
    et.push({ [col]: filtre } as Prisma.UserWhereInput);
  }
  return { AND: et };
}

export function lireCriteres(brut: unknown): Criteres {
  const r = criteresSchema.safeParse(brut);
  if (!r.success) throw new ErreurAdmin(400, "Critères invalides", "INVALID_CRITERIA");
  return r.data;
}

/** POST /estimate : combien de comptes ces critères visent aujourd'hui. */
export async function estimer(brut: unknown) {
  const criteres = gelerCriteres(lireCriteres(brut));
  const count = await prisma.user.count({ where: filtreDepuisCriteres(criteres) });
  return { count, criteria: criteres };
}

/* ══════════════ Présentation (forme de la console) ══════════════ */

const STATUT_CONSOLE: Record<string, string> = {
  planifiee: "scheduled",
  en_cours: "running",
  terminee: "completed",
  echec: "partial_failed",
  annulee: "cancelled",
};

type LigneDiffusion = Prisma.DiffusionGetPayload<object>;

export function presenterDiffusion(d: LigneDiffusion, nomExpediteur: string | null) {
  const traites = d.envoyes + d.refuses + d.echecs;
  return {
    id: Number(d.id),
    senderId: d.expediteurId,
    senderName: nomExpediteur,
    createdBy: d.creePar,
    kind: d.kind,
    content: d.contenu,
    contentEn: (d.traductions as Traductions)?.en ?? null,
    translations: d.traductions,
    type: d.typeMedia,
    mediaUrl: d.mediaUrl,
    backgroundColor: d.couleur,
    criteria: d.criteres,
    estimate: d.estimation,
    clientId: d.clientId,
    status: STATUT_CONSOLE[d.statut] ?? d.statut,
    pushJobsTotal: d.total,
    pushJobsDone: d.envoyes + d.refuses,
    pushFailedJobs: d.echecs,
    pushProgress: d.total > 0 ? Math.round((traites / d.total) * 100) : d.statut === "terminee" ? 100 : 0,
    pushCompletedAt: d.termineeLe,
    deliveredCount: d.envoyes,
    deliveredCountRefreshedAt: d.termineeLe,
    openRate: d.estimation > 0 ? d.envoyes / d.estimation : 0,
    sentAt: d.commenceeLe ?? d.planifieeA,
    scheduledAt: d.planifieeA,
    refusedCount: d.refuses,
  };
}

/* ══════════════ Création ══════════════ */

const creationSchema = z.object({
  content: z.string().optional(),
  contentEn: z.string().nullish(),
  translations: z.record(z.unknown()).optional(),
  backgroundColor: z.string().nullish(),
  type: z.coerce.number().int().optional(),
  kind: z.coerce.number().int().optional(),
  isStatus: z.union([z.boolean(), z.number(), z.string()]).optional(),
  mediaUrl: z.string().nullish(),
  criteria: z.unknown(),
  clientId: z.string().trim().min(8).max(64),
  confirmedEstimate: z.coerce.number().int().nullish(),
  scheduledAt: z.string().datetime({ offset: true }).nullish(),
});

export async function creerDiffusion(brut: unknown, session: SessionAdmin) {
  const corps = creationSchema.safeParse(brut);
  if (!corps.success) throw new ErreurAdmin(400, "Demande invalide", "VALIDATION");
  const c = corps.data;

  const kind = c.kind === 1 || c.isStatus === true || c.isStatus === 1 || c.isStatus === "true" ? 1 : 0;
  const typeMedia = Number(c.type ?? 0);
  if (![0, 1, 2].includes(typeMedia)) throw new ErreurAdmin(400, "type 0, 1 ou 2", "INVALID_TYPE");
  // Un statut porte au plus 700 caractères (notre colonne `statut.text`).
  const max = kind === 1 ? 700 : CONTENU_MAX;
  const traductions = nettoyerTraductions({ fr: c.content, en: c.contentEn ?? undefined, ...(c.translations ?? {}) }, max + 1);
  if (LANGUES_CONTENU.some((l) => (traductions[l]?.length ?? 0) > max)) {
    throw new ErreurAdmin(400, `Le texte dépasse ${max} caractères`, "CONTENT_TOO_LONG");
  }
  const mediaUrl = c.mediaUrl?.trim() || null;
  if (typeMedia !== 0) {
    if (!mediaUrl) throw new ErreurAdmin(400, "Une diffusion image ou vidéo exige un média", "MEDIA_REQUIRED");
    if (!(await mediaDeConsole(mediaUrl))) {
      throw new ErreurAdmin(400, "Le média doit être envoyé depuis la console", "MEDIA_NOT_FOUND");
    }
  }
  const aDuTexte = Object.keys(traductions).length > 0;
  if (typeMedia === 0 && !aDuTexte) throw new ErreurAdmin(400, "Le texte de la diffusion est requis", "CONTENT_REQUIRED");
  // Leur règle : français et anglais requis là où il y a du texte.
  if (aDuTexte && languesManquantes(traductions).length > 0) {
    throw new ErreurAdmin(400, "Traduction manquante : le français et l'anglais sont requis", "TRANSLATION_MISSING");
  }
  let couleur: string | null = null;
  if (kind === 1 && typeMedia === 0 && c.backgroundColor?.trim()) {
    if (!/^#[0-9a-f]{6}$/i.test(c.backgroundColor.trim())) {
      throw new ErreurAdmin(400, "Couleur attendue au format #RRGGBB", "INVALID_COLOR");
    }
    couleur = c.backgroundColor.trim().toUpperCase();
  }
  const contenu = traductions.fr ?? "";

  let planifieeA = new Date();
  if (c.scheduledAt) {
    planifieeA = new Date(c.scheduledAt);
    const ecart = planifieeA.getTime() - Date.now();
    if (ecart < -60_000) throw new ErreurAdmin(400, "La date d'envoi est passée", "SCHEDULE_IN_PAST");
    if (ecart > PLANIFICATION_MAX_JOURS * 86_400_000) {
      throw new ErreurAdmin(400, `Pas plus de ${PLANIFICATION_MAX_JOURS} jours à l'avance`, "SCHEDULE_TOO_FAR");
    }
  }

  const expediteurId = await idCompteOfficielRequis();
  const { count, criteria } = await estimer(c.criteria);
  // Ce que l'admin a confirmé à l'écran doit être ce qu'on lance.
  if (c.confirmedEstimate != null && c.confirmedEstimate !== count) {
    throw new ErreurAdmin(409, "Estimation obsolète", "ESTIMATE_STALE", { count, estimate: count, criteria });
  }

  try {
    return await prisma.diffusion.create({
      data: {
        clientId: c.clientId,
        expediteurId,
        creePar: auteurId(session),
        contenu,
        criteres: criteria as Prisma.InputJsonValue,
        estimation: count,
        planifieeA,
        kind,
        typeMedia,
        mediaUrl: typeMedia === 0 ? null : mediaUrl,
        couleur,
        traductions: traductions as Prisma.InputJsonValue,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ErreurAdmin(409, "Cette diffusion a déjà été lancée", "ALREADY_EXISTS");
    }
    throw e;
  }
}

/** Annule une diffusion planifiée qui n'a pas commencé. */
export async function annulerDiffusion(id: bigint) {
  const r = await prisma.diffusion.updateMany({
    where: { id, statut: "planifiee" },
    data: { statut: "annulee", termineeLe: new Date() },
  });
  if (r.count === 0) throw new ErreurAdmin(404, "Diffusion planifiée introuvable", "JOB_NOT_FOUND");
}

/* ══════════════ Traitement ══════════════ */

/**
 * Prend UNE diffusion à traiter : échue et jamais commencée, ou commencée
 * par un tour dont le verrou a expiré. `SKIP LOCKED` : deux processus ne
 * prennent jamais la même.
 */
async function prendreUneDiffusion(): Promise<bigint | null> {
  const lignes = await prisma.$queryRaw<{ id: bigint }[]>`
    UPDATE "diffusion"
       SET "statut" = 'en_cours',
           "verrou_jusqua" = now() + ${VERROU}::interval,
           "commencee_le" = COALESCE("commencee_le", now())
     WHERE "id" = (
       SELECT "id" FROM "diffusion"
        WHERE ("statut" = 'planifiee' AND "planifiee_a" <= now())
           OR ("statut" = 'en_cours' AND ("verrou_jusqua" IS NULL OR "verrou_jusqua" < now()))
        ORDER BY "planifiee_a"
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
    RETURNING "id"`;
  return lignes[0]?.id ?? null;
}

async function prolongerVerrou(id: bigint) {
  await prisma.$executeRaw`
    UPDATE "diffusion" SET "verrou_jusqua" = now() + ${VERROU}::interval WHERE "id" = ${id}`;
}

async function recompter(id: bigint) {
  const parStatut = await prisma.diffusionEnvoi.groupBy({
    by: ["statut"],
    where: { diffusionId: id },
    _count: { _all: true },
  });
  const n = (s: string) => parStatut.find((p) => p.statut === s)?._count._all ?? 0;
  return { envoyes: n("envoye"), refuses: n("refuse"), echecs: n("echec") };
}

/** Le message d'une diffusion, dans la langue du destinataire. */
async function messageDeDiffusion(d: LigneDiffusion, langue: string | null, convId: string) {
  const texte = texteDans((d.traductions as Traductions) ?? { fr: d.contenu }, langue);
  if (d.typeMedia === 1 || d.typeMedia === 2) {
    const source = await mediaDeConsole(d.mediaUrl);
    if (!source) return { ok: false as const, motif: "MEDIA_ETRANGER" as const };
    const media = await copieDuMedia(source, d.expediteurId);
    return creerMessage({ convId, expediteurId: d.expediteurId, type: d.typeMedia === 1 ? "IMAGE" : "VIDEO", content: texte, mediaId: media.id });
  }
  return creerMessage({ convId, expediteurId: d.expediteurId, type: "TEXT", content: texte ?? d.contenu });
}

/**
 * Diffusion en statut : un statut de 24 h du compte officiel PAR LANGUE
 * rédigée (`statut.text` n'a qu'une langue), créé au début de l'envoi. Rend
 * la table langue → statut, enregistrée sur la diffusion pour la reprise.
 */
async function statutsDeDiffusion(d: LigneDiffusion): Promise<Record<string, string>> {
  if (d.statuts && typeof d.statuts === "object") return d.statuts as Record<string, string>;
  const traductions = (d.traductions as Traductions) ?? {};
  const langues = Object.keys(traductions).length ? (Object.keys(traductions) as (keyof Traductions)[]) : ["fr" as const];
  const maintenant = new Date();
  const statuts: Record<string, string> = {};
  for (const l of langues) {
    const st = await prisma.status.create({
      data: {
        userId: d.expediteurId,
        type: d.typeMedia === 1 ? "IMAGE" : d.typeMedia === 2 ? "VIDEO" : "TEXT",
        text: traductions[l] ?? null,
        mediaUrl: d.typeMedia === 0 ? null : d.mediaUrl,
        bgColor: d.typeMedia === 0 ? d.couleur ?? "#3F51B5" : null,
        createdAt: maintenant,
        expiresAt: new Date(maintenant.getTime() + 24 * 3600 * 1000),
      },
    });
    statuts[l] = st.id;
  }
  await prisma.diffusion.update({ where: { id: d.id }, data: { statuts } });
  return statuts;
}

/** Le statut de la bonne langue : la sienne, sinon l'anglais, sinon le français. */
function statutPour(statuts: Record<string, string>, langue: string | null): string | null {
  return texteDans(statuts as Traductions, langue) ?? Object.values(statuts)[0] ?? null;
}

/** Écrit à UN destinataire, après avoir réservé sa ligne. Rend l'id du message, ou null. */
async function ecrireA(d: LigneDiffusion, userId: string, langue: string | null, statuts: Record<string, string> | null) {
  try {
    // La réservation : si la ligne existe déjà, ce compte est servi (ou en cours).
    await prisma.diffusionEnvoi.create({
      data: { diffusionId: d.id, userId, statut: "echec", motif: "EN_COURS" },
    });
  } catch {
    return null;
  }
  try {
    if (statuts) {
      // En statut : la ligne de visibilité vers celui de sa langue, pas de message.
      const statutId = statutPour(statuts, langue);
      if (statutId) await prisma.gestionStatutDestinataire.create({ data: { statutId, userId } });
      await prisma.diffusionEnvoi.update({
        where: { diffusionId_userId: { diffusionId: d.id, userId } },
        data: statutId ? { statut: "envoye", motif: null } : { statut: "refuse", motif: "STATUT_ABSENT" },
      });
      return null;
    }
    const conv = await findOrCreateDirectConversation(d.expediteurId, userId);
    const r = await messageDeDiffusion(d, langue, conv.id);
    await prisma.diffusionEnvoi.update({
      where: { diffusionId_userId: { diffusionId: d.id, userId } },
      data: r.ok
        ? { statut: "envoye", motif: null, convId: conv.id, messageId: r.message.id }
        : { statut: "refuse", motif: r.motif, convId: conv.id },
    });
    return r.ok ? r.message.id : null;
  } catch (e) {
    await prisma.diffusionEnvoi
      .update({
        where: { diffusionId_userId: { diffusionId: d.id, userId } },
        data: { statut: "echec", motif: String((e as Error)?.message ?? e).slice(0, 60) },
      })
      .catch(() => {});
    return null;
  }
}

async function traiterDiffusion(id: bigint) {
  const d = await prisma.diffusion.findUnique({ where: { id } });
  if (!d || d.statut !== "en_cours") return;

  const cibles = await prisma.user.findMany({
    where: filtreDepuisCriteres(d.criteres as Criteres),
    select: { id: true, langue: true },
    orderBy: { createdAt: "asc" },
  });
  const deja = new Set(
    (await prisma.diffusionEnvoi.findMany({ where: { diffusionId: id }, select: { userId: true } })).map((e) => e.userId),
  );
  await prisma.diffusion.update({ where: { id }, data: { total: cibles.length } });

  let aLivrer: string[] = [];
  let depuisPoint = 0;
  const point = async () => {
    if (aLivrer.length) await livrerMessagesOfficiels(aLivrer);
    aLivrer = [];
    await prisma.diffusion.update({ where: { id }, data: await recompter(id) });
    await prolongerVerrou(id);
  };

  const statuts = d.kind === 1 ? await statutsDeDiffusion(d) : null;
  for (const { id: userId, langue } of cibles) {
    if (deja.has(userId)) continue;
    const messageId = await ecrireA(d, userId, langue, statuts);
    if (messageId) aLivrer.push(messageId);
    if (++depuisPoint >= 25) {
      depuisPoint = 0;
      await point();
    }
  }
  await point();

  const c = await recompter(id);
  await prisma.diffusion.update({
    where: { id },
    data: {
      ...c,
      statut: c.envoyes === 0 && c.echecs > 0 ? "echec" : "terminee",
      termineeLe: new Date(),
      verrouJusqua: null,
    },
  });
}

let enCours = false;

/**
 * Traite ce qui est dû — appelée par la boucle de fond et juste après une
 * création. Un seul passage à la fois DANS ce processus ; entre processus,
 * c'est `SKIP LOCKED` qui sépare.
 */
export async function traiterDiffusionsDues(max = 5): Promise<number> {
  if (enCours) return 0;
  enCours = true;
  let n = 0;
  try {
    for (; n < max; n++) {
      const id = await prendreUneDiffusion();
      if (id === null) break;
      await traiterDiffusion(id).catch((e) => console.error(`[diffusion] ${id} :`, e));
    }
  } finally {
    enCours = false;
  }
  return n;
}
