import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { creerMessage } from "@/modules/messaging/envoi";
import { findOrCreateDirectConversation } from "@/modules/messaging/access";
import { livrerMessagesOfficiels } from "@/lib/salle-temps-reel";
import { TYPE_COMPTE_OFFICIEL } from "@/lib/compte-officiel.mjs";
import { trouverCompteOfficiel } from "./compte-officiel";
import { copieDuMedia, mediaDeConsole } from "./medias";
import { languesManquantes, nettoyerTraductions, texteDans, type Traductions } from "./langues-contenu";
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
 * 🔁 24/10/2026 : à l'identique d'Alanya2026 — des blocs `text`, `image`,
 * `video` et `cta` (boutons), rédigés en français, anglais et chinois. Chaque
 * bloc part comme un message, dans la langue de l'application du destinataire
 * (repli anglais, puis français : `langues-contenu.ts`).
 *
 * ⚠️ LES BOUTONS PARTENT EN TEXTE pour l'instant : nos clients affichent un
 * type de message inconnu comme du texte brut, et un message « boutons »
 * montrerait du JSON. Un bloc `cta` est donc envoyé en texte lisible
 * (« Libellé : lien »), jusqu'à ce que l'application et le web sachent le
 * dessiner.
 */

const BLOCS_MAX = 10;
const TEXTE_MAX = 4000;
const BOUTONS_MAX = 3;

type TypeBloc = "text" | "image" | "video" | "cta";
type Bouton = { action: "route" | "url"; target: string };
/// `texte` : forme d'avant le 24/10/2026 (français seul), relue telle quelle.
type Bloc = {
  ordre: number;
  type: TypeBloc;
  translations?: Traductions;
  texte?: string;
  mediaUrl?: string | null;
  boutons?: Bouton[];
  libellesBoutons?: Traductions[];
};

/** Les traductions d'un bloc, y compris d'un bloc enregistré avant les langues. */
const traductionsDe = (b: Bloc): Traductions => b.translations ?? (b.texte ? { fr: b.texte } : {});
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
    blocks: blocs.map((b, i) => {
      const t = traductionsDe(b);
      const libelles = b.libellesBoutons ?? [];
      return {
        id: i + 1,
        sortOrder: b.ordre,
        blockType: b.type,
        contentFr: t.fr ?? "",
        contentEn: t.en ?? "",
        translations: t,
        mediaUrl: b.mediaUrl ?? undefined,
        ...(b.type === "cta"
          ? {
              ctaJson: {
                buttons: (b.boutons ?? []).map((bt, j) => ({
                  labelFr: libelles[j]?.fr ?? "",
                  labelEn: libelles[j]?.en ?? "",
                  action: bt.action,
                  target: bt.target,
                })),
              },
              ctaTranslations: libelles,
            }
          : {}),
      };
    }),
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
      blockType: z.enum(["text", "image", "video", "cta"]).optional(),
      contentFr: z.string().optional(),
      contentEn: z.string().optional(),
      translations: z.record(z.unknown()).optional(),
      mediaUrl: z.string().max(2000).nullable().optional(),
      ctaJson: z
        .object({
          buttons: z
            .array(
              z.object({
                labelFr: z.string().optional(),
                labelEn: z.string().optional(),
                action: z.string().optional(),
                target: z.string().max(1000).optional(),
              }),
            )
            .max(BOUTONS_MAX),
        })
        .nullable()
        .optional(),
      ctaTranslations: z.array(z.record(z.unknown())).max(BOUTONS_MAX).optional(),
    }),
  )
  .max(BLOCS_MAX);

/** Un bloc de l'éditeur, dans notre forme. Ne contrôle pas les langues : un brouillon reste enregistrable. */
function blocDeLEditeur(b: z.infer<typeof blocsSchema>[number], i: number): Bloc {
  const type: TypeBloc = b.blockType ?? "text";
  const t = nettoyerTraductions({ fr: b.contentFr, en: b.contentEn, ...(b.translations ?? {}) }, TEXTE_MAX);
  const bloc: Bloc = { ordre: b.sortOrder ?? i, type, translations: t };
  if (type === "image" || type === "video") bloc.mediaUrl = b.mediaUrl?.trim() || null;
  if (type === "cta") {
    const boutons = b.ctaJson?.buttons ?? [];
    bloc.boutons = boutons.map((bt) => ({ action: bt.action === "url" ? "url" : "route", target: (bt.target ?? "").trim() }));
    bloc.libellesBoutons = boutons.map((bt, j) =>
      nettoyerTraductions({ fr: bt.labelFr, en: bt.labelEn, ...(b.ctaTranslations?.[j] ?? {}) }, 60),
    );
    bloc.translations = {};
  }
  return bloc;
}

/** Un bloc utile : du texte, un média, ou au moins un bouton. */
function blocUtile(b: Bloc): boolean {
  if (b.type === "image" || b.type === "video") return !!b.mediaUrl;
  if (b.type === "cta") return (b.boutons ?? []).length > 0;
  return Object.keys(traductionsDe(b)).length > 0;
}

export async function enregistrerBrouillon(brut: unknown) {
  const r = blocsSchema.safeParse((brut as { blocks?: unknown })?.blocks);
  if (!r.success) throw new ErreurAdmin(400, `De 1 à ${BLOCS_MAX} blocs`, "VALIDATION");
  const blocs: Bloc[] = r.data
    .map(blocDeLEditeur)
    .filter(blocUtile)
    .sort((a, b) => a.ordre - b.ordre)
    .map((b, i) => ({ ...b, ordre: i }));
  if (blocs.length === 0) throw new ErreurAdmin(400, "Le message est vide", "CONTENT_REQUIRED");
  for (const b of blocs) {
    if ((b.type === "image" || b.type === "video") && !(await mediaDeConsole(b.mediaUrl))) {
      throw new ErreurAdmin(400, `Bloc ${b.ordre + 1} : le média doit être envoyé depuis la console`, "MEDIA_NOT_FOUND");
    }
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
    // Leur règle : les langues requises (fr, en) sont exigées à la publication
    // seulement, et seulement là où il y a du texte — une légende vide partout
    // est permise sur une image ou une vidéo. Les libellés des boutons aussi.
    const blocs = (b.blocs as Bloc[]) ?? [];
    const nonTraduits = blocs
      .filter((x) => x.type !== "cta")
      .filter((x) => Object.keys(traductionsDe(x)).length > 0 && languesManquantes(traductionsDe(x)).length > 0)
      .map((x) => x.ordre + 1);
    if (nonTraduits.length) {
      throw new ErreurAdmin(400, `Traduction manquante — bloc(s) ${nonTraduits.join(", ")}`, "TRANSLATION_MISSING");
    }
    const boutonsNonTraduits = blocs
      .filter((x) => x.type === "cta" && (x.libellesBoutons ?? []).some((l) => languesManquantes(l).length > 0))
      .map((x) => x.ordre + 1);
    if (boutonsNonTraduits.length) {
      throw new ErreurAdmin(400, `Libellé de bouton non traduit — bloc(s) ${boutonsNonTraduits.join(", ")}`, "TRANSLATION_MISSING");
    }
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
    const blocs = ((v?.blocs as Bloc[]) ?? []).filter(blocUtile);
    if (!v || blocs.length === 0) return [];
    const officiel = await trouverCompteOfficiel();
    if (!officiel || officiel.id === userId) return [];
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { isDelete: true, exclus: true, typeCompte: true, langue: true } });
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
      const r = await messageDuBloc(b, u.langue, conv.id, officiel.id);
      if (r === null) continue;
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

/**
 * Écrit le message d'un bloc, dans la langue du destinataire. `null` si le
 * bloc n'a rien à dire dans cette langue ni dans le repli.
 */
async function messageDuBloc(b: Bloc, langue: string | null, convId: string, officielId: string) {
  const texte = texteDans(traductionsDe(b), langue);
  if (b.type === "image" || b.type === "video") {
    const source = await mediaDeConsole(b.mediaUrl);
    if (!source) return null;
    const media = await copieDuMedia(source, officielId);
    return creerMessage({ convId, expediteurId: officielId, type: b.type === "image" ? "IMAGE" : "VIDEO", content: texte, mediaId: media.id });
  }
  if (b.type === "cta") {
    const lignes = (b.boutons ?? [])
      .map((bt, j) => {
        const libelle = texteDans(b.libellesBoutons?.[j] ?? {}, langue);
        return libelle && bt.target ? `${libelle} : ${bt.target}` : null;
      })
      .filter((x): x is string => !!x);
    if (!lignes.length) return null;
    return creerMessage({ convId, expediteurId: officielId, type: "TEXT", content: lignes.join("\n") });
  }
  if (!texte) return null;
  return creerMessage({ convId, expediteurId: officielId, type: "TEXT", content: texte });
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

