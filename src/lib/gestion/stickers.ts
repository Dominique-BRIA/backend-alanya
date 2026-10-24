import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { saveBuffer } from "@/modules/media/storage";
import { ErreurAdmin } from "./reponses";
import { ecrireReglage, lireReglage } from "./outils";
import { type SessionAdmin } from "./session";

/**
 * LES STICKERS (console de gestion, 16/10/2026).
 *
 * La console crée des PACKS officiels, y téléverse des images, et les publie.
 * L'application les lira par `GET /api/stickers` (étape mobile) ; chaque
 * image est servie par `GET /api/stickers/fichier/:id`, sans jeton — un
 * sticker publié est un contenu public.
 *
 * ⚠️ UN FICHIER, UNE LIGNE : `sticker_asset.empreinte` (SHA-256) est unique.
 * Le même fichier téléversé deux fois n'est stocké qu'une fois, et un retrait
 * (`takedown`) le retire PARTOUT où il sert.
 */

const MIMES = new Set(["image/png", "image/webp", "image/gif", "image/jpeg"]);
const OCTETS_MAX = 1024 * 1024;
const FICHIERS_PAR_ENVOI = 30;
const STICKERS_PAR_PACK = 120;

export const urlFichier = (assetId: bigint | number) => `${env.publicBaseUrl}/api/stickers/fichier/${assetId}`;

type Traductions = Record<string, string>;
const traductions = (v: unknown): Traductions | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const t = Object.fromEntries(
    Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === "string" && x.trim()).map(([k, x]) => [k, String(x).trim().slice(0, 100)]),
  );
  return Object.keys(t).length ? t : null;
};

type PackAvecCompte = Prisma.StickerPackGetPayload<{ include: { _count: { select: { stickers: true } } } }>;

async function presenterPack(p: PackAvecCompte) {
  let couverture: string | null = null;
  if (p.couvertureId) {
    const s = await prisma.sticker.findUnique({ where: { id: p.couvertureId }, select: { assetId: true } });
    if (s) couverture = urlFichier(s.assetId);
  }
  return {
    id: Number(p.id),
    code: p.code,
    nameI18n: p.nom,
    descriptionI18n: p.description,
    author: p.auteur,
    coverStickerId: p.couvertureId ? Number(p.couvertureId) : null,
    coverUrl: couverture,
    isPremium: p.premium ? 1 : 0,
    visibility: 0,
    status: p.statut,
    shareToken: null,
    sortOrder: p.ordre,
    version: p.version,
    publishedAt: p.publieLe,
    createdAt: p.creeLe,
    updatedAt: p.modifieLe,
    stickerCount: p._count.stickers,
  };
}

const AVEC_COMPTE = { _count: { select: { stickers: true } } } as const;

export async function listerPacks(p: URLSearchParams) {
  const statut = p.get("status");
  const q = p.get("q")?.trim();
  const packs = await prisma.stickerPack.findMany({
    where: {
      ...(statut !== null && statut !== "" ? { statut: Number(statut) } : {}),
      ...(q ? { code: { contains: q.toLowerCase() } } : {}),
    },
    orderBy: [{ ordre: "asc" }, { creeLe: "desc" }],
    include: AVEC_COMPTE,
  });
  return Promise.all(packs.map(presenterPack));
}

async function packRequis(id: bigint) {
  const p = await prisma.stickerPack.findUnique({ where: { id }, include: AVEC_COMPTE });
  if (!p) throw new ErreurAdmin(404, "Pack introuvable", "STICKER_PACK_NOT_FOUND");
  return p;
}

export async function detailPack(id: bigint) {
  const p = await packRequis(id);
  const stickers = await prisma.sticker.findMany({ where: { packId: id }, orderBy: { position: "asc" }, include: { asset: true } });
  return {
    pack: await presenterPack(p),
    stickers: stickers.map((s) => ({
      id: Number(s.id),
      position: s.position,
      emoji: s.emoji,
      nameI18n: s.nom,
      assetId: Number(s.assetId),
      assetStatus: s.asset.statut,
      url: urlFichier(s.assetId),
      thumbUrl: null,
      width: null,
      height: null,
      bytes: s.asset.octets,
      animated: s.asset.anime ? 1 : 0,
    })),
  };
}

const enCode = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

export async function creerPack(brut: unknown) {
  const c = (brut ?? {}) as Record<string, unknown>;
  const nom = traductions(c.name_i18n);
  if (!nom?.fr) throw new ErreurAdmin(400, "Le nom en français est requis", "VALIDATION");
  const code = enCode(typeof c.code === "string" && c.code.trim() ? c.code : nom.fr) || `pack-${Date.now()}`;
  try {
    const p = await prisma.stickerPack.create({
      data: {
        code,
        nom,
        description: traductions(c.description_i18n) ?? Prisma.JsonNull,
        auteur: typeof c.author === "string" ? c.author.trim().slice(0, 100) || null : null,
        premium: c.is_premium === true,
        ordre: Number.isInteger(c.sort_order) ? Number(c.sort_order) : 0,
      },
    });
    return { id: Number(p.id), code: p.code };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ErreurAdmin(409, "Ce code de pack existe déjà", "CODE_TAKEN");
    }
    throw e;
  }
}

export async function modifierPack(id: bigint, brut: unknown) {
  await packRequis(id);
  const c = (brut ?? {}) as Record<string, unknown>;
  const data: Prisma.StickerPackUpdateInput = { modifieLe: new Date() };
  if (c.name_i18n !== undefined) {
    const nom = traductions(c.name_i18n);
    if (!nom?.fr) throw new ErreurAdmin(400, "Le nom en français est requis", "VALIDATION");
    data.nom = nom;
  }
  if (c.description_i18n !== undefined) data.description = traductions(c.description_i18n) ?? Prisma.JsonNull;
  if (c.author !== undefined) data.auteur = typeof c.author === "string" ? c.author.trim().slice(0, 100) || null : null;
  if (c.is_premium !== undefined) data.premium = c.is_premium === true;
  if (c.sort_order !== undefined && Number.isInteger(c.sort_order)) data.ordre = Number(c.sort_order);
  if (c.cover_sticker_id !== undefined) {
    if (c.cover_sticker_id === null) data.couvertureId = null;
    else {
      const s = await prisma.sticker.findFirst({ where: { id: BigInt(Number(c.cover_sticker_id)), packId: id } });
      if (!s) throw new ErreurAdmin(400, "La vignette doit être un sticker du pack", "VALIDATION");
      data.couvertureId = s.id;
    }
  }
  await prisma.stickerPack.update({ where: { id }, data });
}

/** Téléverse des images dans un pack. Un fichier déjà connu est réutilisé, pas restocké. */
export async function televerser(id: bigint, form: FormData) {
  const p = await packRequis(id);
  const fichiers = form.getAll("files").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
  if (fichiers.length === 0) throw new ErreurAdmin(400, "Aucun fichier", "VALIDATION");
  if (fichiers.length > FICHIERS_PAR_ENVOI) throw new ErreurAdmin(400, `${FICHIERS_PAR_ENVOI} fichiers au plus par envoi`, "VALIDATION");
  if (p._count.stickers + fichiers.length > STICKERS_PAR_PACK) {
    throw new ErreurAdmin(400, `${STICKERS_PAR_PACK} stickers au plus par pack`, "PACK_FULL");
  }
  const emoji = String(form.get("emoji") ?? "").trim().slice(0, 16);
  const derniere = await prisma.sticker.aggregate({ where: { packId: id }, _max: { position: true } });
  let position = (derniere._max.position ?? -1) + 1;
  const crees = [];
  for (const f of fichiers) {
    if (!MIMES.has(f.type)) throw new ErreurAdmin(400, `${f.name} : PNG, WebP, GIF ou JPEG attendu`, "UNSUPPORTED_TYPE");
    if (f.size > OCTETS_MAX) throw new ErreurAdmin(400, `${f.name} : 1 Mo au plus`, "FILE_TOO_LARGE");
    const octets = Buffer.from(await f.arrayBuffer());
    const empreinte = createHash("sha256").update(octets).digest("hex");
    let asset = await prisma.stickerAsset.findUnique({ where: { empreinte } });
    const reutilise = !!asset;
    if (!asset) {
      const { relativeUrl, espace } = await saveBuffer(octets, f.name || "sticker", f.type, "public");
      asset = await prisma.stickerAsset.create({
        data: { url: relativeUrl, espace: espace === "public" ? "public" : null, mime: f.type, octets: octets.length, empreinte, anime: f.type === "image/gif" },
      });
    }
    const s = await prisma.sticker.create({ data: { packId: id, assetId: asset.id, position: position++, emoji } });
    crees.push({ id: Number(s.id), position: s.position, bytes: asset.octets, reutilise });
  }
  await prisma.stickerPack.update({ where: { id }, data: { modifieLe: new Date(), ...(p.statut === 1 ? { version: { increment: 1 } } : {}) } });
  return crees;
}

export async function modifierSticker(id: bigint, brut: unknown) {
  const s = await prisma.sticker.findUnique({ where: { id } });
  if (!s) throw new ErreurAdmin(404, "Sticker introuvable", "STICKER_NOT_FOUND");
  const c = (brut ?? {}) as Record<string, unknown>;
  await prisma.sticker.update({
    where: { id },
    data: {
      ...(typeof c.emoji === "string" ? { emoji: c.emoji.trim().slice(0, 16) } : {}),
      ...(Number.isInteger(c.position) ? { position: Number(c.position) } : {}),
      ...(c.name_i18n !== undefined ? { nom: traductions(c.name_i18n) ?? {} } : {}),
    },
  });
}

export async function supprimerSticker(id: bigint) {
  const s = await prisma.sticker.findUnique({ where: { id } });
  if (!s) throw new ErreurAdmin(404, "Sticker introuvable", "STICKER_NOT_FOUND");
  await prisma.$transaction([
    prisma.stickerPack.updateMany({ where: { couvertureId: id }, data: { couvertureId: null } }),
    prisma.sticker.delete({ where: { id } }),
  ]);
}

/** Publie un pack complet : nom français, au moins un sticker, une vignette. */
export async function publierPack(id: bigint) {
  const p = await packRequis(id);
  const manque: string[] = [];
  if (!(p.nom as Traductions)?.fr) manque.push("name_fr");
  if (p._count.stickers === 0) manque.push("stickers");
  if (!p.couvertureId) manque.push("cover");
  if (manque.length) throw new ErreurAdmin(422, "Pack incomplet", "STICKER_PACK_INCOMPLETE", { missing: manque });
  await prisma.stickerPack.update({ where: { id }, data: { statut: 1, publieLe: p.publieLe ?? new Date(), modifieLe: new Date() } });
  return { status: 1 };
}

export async function archiverPack(id: bigint) {
  const p = await packRequis(id);
  await prisma.stickerPack.update({ where: { id }, data: { statut: 2, modifieLe: new Date() } });
  return { status: 2, code: p.code };
}

/* ══════════════ Réglages, signalements, retraits ══════════════ */

const CLE = "stickers";
const DEFAUT = { enabled: false, creationEnabled: false, animatedEnabled: true, minAppVersion: null as string | null };

export async function lireReglages() {
  const r = await lireReglage(CLE, DEFAUT);
  return {
    id: 1,
    enabled: r.valeur.enabled ? 1 : 0,
    creationEnabled: r.valeur.creationEnabled ? 1 : 0,
    animatedEnabled: r.valeur.animatedEnabled ? 1 : 0,
    minAppVersion: r.valeur.minAppVersion,
    updatedBy: r.modifiePar,
    updatedAt: r.modifieLe,
  };
}

export async function ecrireReglages(brut: unknown, session: SessionAdmin) {
  const c = (brut ?? {}) as Record<string, unknown>;
  const { valeur } = await lireReglage(CLE, DEFAUT);
  const v = { ...valeur };
  if (typeof c.enabled === "boolean") v.enabled = c.enabled;
  if (typeof c.creation_enabled === "boolean") v.creationEnabled = c.creation_enabled;
  if (typeof c.animated_enabled === "boolean") v.animatedEnabled = c.animated_enabled;
  if (c.min_app_version !== undefined) {
    const s = typeof c.min_app_version === "string" ? c.min_app_version.trim() : "";
    if (s && !/^\d+\.\d+\.\d+$/.test(s)) throw new ErreurAdmin(400, "Version attendue : 1.2.3", "VALIDATION");
    v.minAppVersion = s || null;
  }
  await ecrireReglage(CLE, v, session);
  return lireReglages();
}

export async function signalementsStickers() {
  const lignes = await prisma.stickerSignalement.findMany({ orderBy: { creeLe: "desc" }, take: 200, include: { asset: true } });
  const auteurs = await prisma.user.findMany({ where: { id: { in: lignes.map((l) => l.auteurId) } }, select: { id: true, nom: true, pseudo: true } });
  return lignes.map((l) => {
    const a = auteurs.find((u) => u.id === l.auteurId);
    return {
      id: Number(l.id),
      assetId: Number(l.assetId),
      reporterId: l.auteurId,
      reason: l.motif,
      status: l.statut,
      createdAt: l.creeLe,
      assetStatus: l.asset.statut,
      url: urlFichier(l.assetId),
      thumbUrl: null,
      reporterNom: a?.nom ?? null,
      reporterPseudo: a?.pseudo ?? null,
    };
  });
}

/** Retire un fichier partout où il sert : il n'est plus servi, et ses signalements sont traités. */
export async function retirerFichier(id: bigint) {
  const a = await prisma.stickerAsset.findUnique({ where: { id } });
  if (!a) throw new ErreurAdmin(404, "Fichier introuvable", "STICKER_ASSET_NOT_FOUND");
  await prisma.$transaction([
    prisma.stickerAsset.update({ where: { id }, data: { statut: 1 } }),
    prisma.stickerSignalement.updateMany({ where: { assetId: id }, data: { statut: 1 } }),
  ]);
}

/* ══════════════ Côté application ══════════════ */

/** Les packs publiés, si les stickers sont ouverts. */
export async function packsPublies() {
  const r = await lireReglage(CLE, DEFAUT);
  if (!r.valeur.enabled) return { enabled: false, packs: [] };
  const packs = await prisma.stickerPack.findMany({
    where: { statut: 1 },
    orderBy: [{ ordre: "asc" }, { publieLe: "desc" }],
    include: { stickers: { where: { asset: { statut: 0 } }, orderBy: { position: "asc" }, include: { asset: true } } },
  });
  return {
    enabled: true,
    animatedEnabled: r.valeur.animatedEnabled,
    minAppVersion: r.valeur.minAppVersion,
    packs: packs.map((p) => ({
      id: Number(p.id),
      code: p.code,
      nom: p.nom,
      description: p.description,
      auteur: p.auteur,
      version: p.version,
      couverture: p.couvertureId ? urlFichier(p.stickers.find((s) => s.id === p.couvertureId)?.assetId ?? 0) : null,
      stickers: p.stickers
        .filter((s) => r.valeur.animatedEnabled || !s.asset.anime)
        // `assetId` (24/10/2026) : c'est lui que porte un message sticker,
        // et `nom` sert à la recherche et à l'accessibilité.
        .map((s) => ({
          id: Number(s.id),
          assetId: Number(s.assetId),
          emoji: s.emoji,
          nom: s.nom,
          url: urlFichier(s.assetId),
          anime: s.asset.anime,
        })),
    })),
  };
}
