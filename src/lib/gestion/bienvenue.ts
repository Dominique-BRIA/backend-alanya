import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { creerMessage } from "@/modules/messaging/envoi";
import { findOrCreateDirectConversation } from "@/modules/messaging/access";
import { livrerMessagesOfficiels } from "@/lib/salle-temps-reel";
import { TYPE_COMPTE_OFFICIEL } from "@/lib/compte-officiel.mjs";
import { trouverCompteOfficiel } from "./compte-officiel";
import { ErreurAdmin } from "./reponses";
import { auteur, ecrireReglage, lireReglage } from "./outils";
import { type SessionAdmin } from "./session";

/**
 * LE MESSAGE DE BIENVENUE (console de gestion, lot 1c, 16/10/2026).
 *
 * Écrit dans la console, publié, puis envoyé par « Alanya Work » :
 *   - à CHAQUE compte qui termine son inscription (`POST /api/auth/setup`),
 *     ou que la console crée ;
 *   - aux comptes EXISTANTS, une fois, par le rattrapage.
 *
 * 🔴 UNE FOIS PAR COMPTE, QUELLE QUE SOIT LA VERSION. La ligne de
 * `gestion_bienvenue_envoi` a le compte pour clé et elle est RÉSERVÉE avant
 * d'écrire : une inscription et un rattrapage simultanés, ou deux
 * processus, ne peuvent pas l'envoyer deux fois. Republier une version ne
 * renvoie rien à ceux qui l'ont déjà reçue.
 *
 * Décisions du user (15/10) : en français seul, des blocs de TEXTE (chacun
 * part comme un message), pas de statut de bienvenue.
 */

const BLOCS_MAX = 5;
const TEXTE_MAX = 4000;

type Bloc = { ordre: number; type: "text"; texte: string };
type Version = Prisma.GestionBienvenueGetPayload<object>;

function presenterVersion(v: Version | null) {
  if (!v) return null;
  const blocs = (v.blocs as Bloc[]) ?? [];
  return {
    id: Number(v.id),
    version: v.version,
    isActive: v.etat === "publie",
    isDraft: v.etat === "brouillon",
    publishedAt: v.publieLe,
    publishedBy: null,
    blocks: blocs.map((b, i) => ({
      id: i + 1,
      sortOrder: b.ordre,
      blockType: "text" as const,
      contentFr: b.texte,
      translations: { fr: b.texte },
    })),
  };
}

const versionPubliee = () => prisma.gestionBienvenue.findFirst({ where: { etat: "publie" } });
const brouillon = () => prisma.gestionBienvenue.findFirst({ where: { etat: "brouillon" } });

/** Les comptes qui n'ont jamais reçu la bienvenue et peuvent la recevoir. */
async function comptesEnAttente(limite?: number): Promise<string[]> {
  const lignes = await prisma.$queryRaw<{ id: string }[]>`
    SELECT u."alanyaID"::text AS id FROM "users" u
     WHERE u."isDelete" = false AND u."exclus" = 0 AND u."actif" = 1
       AND u."type_compte" <> ${TYPE_COMPTE_OFFICIEL}
       AND u."password" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "gestion_bienvenue_envoi" e WHERE e."user_id" = u."alanyaID")
     ORDER BY u."created_at" ASC
     LIMIT ${limite ?? 1_000_000}`;
  return lignes.map((l) => l.id);
}

async function nombreEnAttente(): Promise<number> {
  const [r] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "users" u
     WHERE u."isDelete" = false AND u."exclus" = 0 AND u."actif" = 1
       AND u."type_compte" <> ${TYPE_COMPTE_OFFICIEL}
       AND u."password" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "gestion_bienvenue_envoi" e WHERE e."user_id" = u."alanyaID")`;
  return Number(r?.n ?? 0);
}

/*
 * 🐛 LE MESSAGE PUBLIÉ DISPARAISSAIT DE LA CONSOLE (signalé le 24/10/2026) :
 * publier transforme le brouillon en version publiée, il n'en reste donc
 * plus, et la console — qui remplit son éditeur avec `draft` — s'ouvrait
 * vide. Comme le serveur d'Alanya2026 (`draft: draft ?? active`), sans
 * brouillon en cours on rend la version publiée : l'éditeur la montre, et la
 * modifier crée un nouveau brouillon.
 */
export async function etatBienvenue() {
  const [actif, brou, pendingBackfill] = await Promise.all([versionPubliee(), brouillon(), nombreEnAttente()]);
  return { active: presenterVersion(actif), draft: presenterVersion(brou ?? actif), pendingBackfill };
}

const blocsSchema = z
  .array(
    z.object({
      sortOrder: z.coerce.number().int().optional(),
      blockType: z.string().optional(),
      contentFr: z.string().optional(),
      translations: z.record(z.string()).optional(),
    }),
  )
  .max(BLOCS_MAX);

export async function enregistrerBrouillon(brut: unknown) {
  const r = blocsSchema.safeParse((brut as { blocks?: unknown })?.blocks);
  if (!r.success) throw new ErreurAdmin(400, `De 1 à ${BLOCS_MAX} blocs`, "VALIDATION");
  if (r.data.some((b) => b.blockType && b.blockType !== "text")) {
    throw new ErreurAdmin(400, "Seuls les blocs de texte sont pris en charge", "BLOCK_TYPE_NOT_SUPPORTED");
  }
  const blocs: Bloc[] = r.data
    .map((b, i) => ({ ordre: b.sortOrder ?? i, type: "text" as const, texte: (b.translations?.fr ?? b.contentFr ?? "").trim() }))
    .filter((b) => b.texte)
    .sort((a, b) => a.ordre - b.ordre)
    .map((b, i) => ({ ...b, ordre: i }));
  if (blocs.length === 0) throw new ErreurAdmin(400, "Le message est vide", "CONTENT_REQUIRED");
  if (blocs.some((b) => b.texte.length > TEXTE_MAX)) {
    throw new ErreurAdmin(400, `Un bloc dépasse ${TEXTE_MAX} caractères`, "CONTENT_TOO_LONG");
  }
  const existant = await brouillon();
  if (existant) {
    return presenterVersion(await prisma.gestionBienvenue.update({ where: { id: existant.id }, data: { blocs } }));
  }
  const derniere = await prisma.gestionBienvenue.aggregate({ _max: { version: true } });
  return presenterVersion(
    await prisma.gestionBienvenue.create({ data: { etat: "brouillon", version: (derniere._max.version ?? 0) + 1, blocs } }),
  );
}

/** Le brouillon devient LA version publiée ; la précédente est archivée. */
export async function publier(session: SessionAdmin) {
  const v = await prisma.$transaction(async (tx) => {
    const b = await tx.gestionBienvenue.findFirst({ where: { etat: "brouillon" } });
    // L'éditeur montre la version publiée quand il n'y a pas de brouillon :
    // « Publier » sans rien modifier ne doit pas parler de brouillon absent.
    if (!b) throw new ErreurAdmin(409, "Aucune modification à publier : cette version est déjà en ligne", "NO_DRAFT");
    await tx.gestionBienvenue.updateMany({ where: { etat: "publie" }, data: { etat: "archive" } });
    return tx.gestionBienvenue.update({
      where: { id: b.id },
      data: { etat: "publie", publieLe: new Date(), publiePar: auteur(session) },
    });
  });
  return presenterVersion(v);
}

/**
 * Envoie la bienvenue publiée à UN compte, s'il ne l'a jamais reçue.
 * Rend les identifiants des messages écrits (vide si rien n'est parti). Ne
 * lève jamais : une inscription ne doit pas échouer parce que la bienvenue
 * n'a pas pu partir.
 */
export async function envoyerBienvenue(userId: string, livrer = true): Promise<string[]> {
  try {
    const v = await versionPubliee();
    const blocs = ((v?.blocs as Bloc[]) ?? []).filter((b) => b.texte);
    if (!v || blocs.length === 0) return [];
    const officiel = await trouverCompteOfficiel();
    if (!officiel || officiel.id === userId) return [];
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { isDelete: true, exclus: true, typeCompte: true } });
    if (!u || u.isDelete || u.exclus === 1 || u.typeCompte === TYPE_COMPTE_OFFICIEL) return [];

    // La réservation : une clé par compte, l'unicité de la base tranche.
    try {
      await prisma.gestionBienvenueEnvoi.create({
        data: { userId, version: v.version, statut: "echec", motif: "EN_COURS" },
      });
    } catch {
      return [];
    }

    const conv = await findOrCreateDirectConversation(officiel.id, userId);
    const ids: string[] = [];
    let refus: string | null = null;
    for (const b of blocs) {
      const r = await creerMessage({ convId: conv.id, expediteurId: officiel.id, type: "TEXT", content: b.texte });
      if (r.ok) ids.push(r.message.id);
      else {
        refus = r.motif;
        break;
      }
    }
    await prisma.gestionBienvenueEnvoi.update({
      where: { userId },
      data: ids.length ? { statut: "envoye", motif: null } : { statut: "refuse", motif: refus },
    });
    if (livrer && ids.length) await livrerMessagesOfficiels(ids);
    return ids;
  } catch (e) {
    console.error(`[bienvenue] ${userId} :`, e);
    await prisma.gestionBienvenueEnvoi
      .update({ where: { userId }, data: { statut: "echec", motif: String((e as Error)?.message ?? e).slice(0, 60) } })
      .catch(() => {});
    return [];
  }
}

const CLE_RATTRAPAGE = "bienvenue.rattrapage";

/** Demande le rattrapage ; le travail se fait juste après la réponse, et la boucle de fond le reprend. */
export async function demanderRattrapage(session: SessionAdmin) {
  if (!(await versionPubliee())) {
    return { queued: false, pending: 0, reason: "Publiez d'abord un message de bienvenue" };
  }
  if (!(await trouverCompteOfficiel())) {
    return { queued: false, pending: 0, reason: "Créez d'abord le compte officiel" };
  }
  await ecrireReglage(CLE_RATTRAPAGE, { actif: true, demandeLe: new Date().toISOString() }, session);
  return { queued: true, pending: await nombreEnAttente() };
}

let rattrapageEnCours = false;

/** Fait avancer le rattrapage demandé, s'il y en a un. Un seul passage à la fois par processus. */
export async function poursuivreRattrapage(): Promise<number> {
  if (rattrapageEnCours) return 0;
  const { valeur } = await lireReglage(CLE_RATTRAPAGE, { actif: false });
  if (!(valeur as { actif: boolean }).actif) return 0;
  rattrapageEnCours = true;
  let envoyes = 0;
  try {
    for (;;) {
      const lot = await comptesEnAttente(100);
      if (lot.length === 0) break;
      const ids: string[] = [];
      for (const id of lot) {
        const ecrits = await envoyerBienvenue(id, false);
        if (ecrits.length) envoyes++;
        ids.push(...ecrits);
      }
      // Livraison groupée du lot, une fois tous ses messages écrits.
      if (ids.length) await livrerMessagesOfficiels(ids);
      // ⚠️ GARDE-FOU : si aucun compte du lot n'a reçu sa ligne (compte
      // officiel supprimé, version dépubliée en cours de route), le même lot
      // reviendrait au tour suivant — sans fin.
      if ((await prisma.gestionBienvenueEnvoi.count({ where: { userId: { in: lot } } })) === 0) break;
      // Un compte qui ne peut pas la recevoir garde sa ligne (refus/échec) : il ne revient pas.
    }
    await prisma.gestionReglage.update({ where: { cle: CLE_RATTRAPAGE }, data: { valeur: { actif: false, termineLe: new Date().toISOString() } } });
  } finally {
    rattrapageEnCours = false;
  }
  return envoyes;
}

/** Le statut de bienvenue est exclu (décision du 15/10) : la console le lit désactivé. */
export const STATUT_BIENVENUE_DESACTIVE = {
  enabled: false,
  blocks: [],
  updatedAt: null,
  updatedBy: null,
  supportsMultiple: true,
};
