import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { lireReglage } from "@/lib/gestion/outils";
import { urlFichier } from "@/lib/gestion/stickers";
import { rateLimit } from "@/lib/rate-limit";
import { saveBuffer } from "@/modules/media/storage";
import { ErreurStickers } from "@/lib/stickers-utilisateur";

/**
 * CRÉER SES STICKERS (25/10/2026, demande du user : « comme sur WhatsApp »).
 *
 * Chaque compte a UN pack personnel, « Mes créations », créé à son premier
 * sticker. Il porte son propriétaire (`sticker_pack.proprietaire_id`) :
 *
 * - il n'apparaît ni au catalogue (`GET /api/stickers`) ni dans la console ;
 * - seul son propriétaire en ENVOIE les stickers (`sticker-message.mjs`) ;
 * - un destinataire qui veut le garder en fait une COPIE dans son propre
 *   pack (`copierSticker`) — la même image, une autre ligne, comme la
 *   référence d'Alanya2026 (`POST /stickers/:id/copy`).
 *
 * Tout est derrière DEUX interrupteurs de la console : `enabled` et
 * `creationEnabled`. Fermé : 404, rien n'est révélé.
 *
 * ⚠️ SUPPRIMER UN STICKER NE RETIRE PAS SON IMAGE : les messages déjà envoyés
 * la lisent encore. Seule la modération (retrait du fichier) l'efface partout.
 */

const OCTETS_MAX = 1024 * 1024;
const COTE_MAX = 1024;
export const CREATIONS_MAX = 120;
const CREATIONS_PAR_HEURE = 30;

const NOM_PACK = {
  fr: "Mes créations",
  en: "My creations",
  es: "Mis creaciones",
  de: "Meine Sticker",
  pt: "As minhas criações",
  ru: "Мои стикеры",
  zh: "我的贴纸",
  sv: "Mina klistermärken",
  no: "Mine klistremerker",
};

export async function creationOuverte(): Promise<boolean> {
  const r = await lireReglage("stickers", { enabled: false, creationEnabled: false });
  return r.valeur.enabled === true && r.valeur.creationEnabled === true;
}

async function exigerCreation() {
  if (!(await creationOuverte())) throw new ErreurStickers(404, "NOT_FOUND", "Introuvable");
}

/**
 * Le type RÉEL et les dimensions d'une image, lus dans ses octets — jamais
 * dans ce que le client annonce. PNG et WebP seulement : ce que produisent
 * les deux clients (capture d'écran du cadre, `canvas.toBlob`).
 */
export function lireImage(o: Buffer): { mime: "image/png" | "image/webp"; largeur: number; hauteur: number } | null {
  if (o.length > 24 && o.readUInt32BE(0) === 0x89504e47 && o.toString("latin1", 12, 16) === "IHDR") {
    return { mime: "image/png", largeur: o.readUInt32BE(16), hauteur: o.readUInt32BE(20) };
  }
  if (o.length > 30 && o.toString("latin1", 0, 4) === "RIFF" && o.toString("latin1", 8, 12) === "WEBP") {
    const bloc = o.toString("latin1", 12, 16);
    if (bloc === "VP8X") {
      return { mime: "image/webp", largeur: 1 + o.readUIntLE(24, 3), hauteur: 1 + o.readUIntLE(27, 3) };
    }
    if (bloc === "VP8L" && o[20] === 0x2f) {
      const b = o.readUInt32LE(21);
      return { mime: "image/webp", largeur: 1 + (b & 0x3fff), hauteur: 1 + ((b >> 14) & 0x3fff) };
    }
    if (bloc === "VP8 ") {
      return { mime: "image/webp", largeur: o.readUInt16LE(26) & 0x3fff, hauteur: o.readUInt16LE(28) & 0x3fff };
    }
  }
  return null;
}

/** Mon pack personnel ; créé à la demande (`creer`), sinon `null`. */
async function monPack(userId: string, creer: boolean) {
  const existant = await prisma.stickerPack.findFirst({ where: { proprietaireId: userId } });
  if (existant || !creer) return existant;
  try {
    return await prisma.stickerPack.create({
      data: {
        code: `perso-${userId}`,
        nom: NOM_PACK,
        proprietaireId: userId,
        statut: 1,
        publieLe: new Date(),
      },
    });
  } catch {
    // Deux créations simultanées : l'index unique a tranché, on relit.
    return prisma.stickerPack.findFirst({ where: { proprietaireId: userId } });
  }
}

/** `GET /api/stickers/me/created` — mes créations, la plus récente d'abord. */
export async function mesCreations(userId: string) {
  const p = await monPack(userId, false);
  if (!p) return null;
  const stickers = await prisma.sticker.findMany({
    where: { packId: p.id, asset: { statut: 0 } },
    orderBy: [{ position: "asc" }, { id: "desc" }],
    include: { asset: { select: { anime: true } } },
  });
  return {
    id: Number(p.id),
    code: p.code,
    nom: p.nom,
    stickers: stickers.map((s) => ({
      id: Number(s.id),
      assetId: Number(s.assetId),
      emoji: s.emoji,
      nom: s.nom,
      url: urlFichier(s.assetId),
      anime: s.asset.anime,
    })),
  };
}

/** Range une image (même fichier = même ligne, comme la console) et l'ajoute EN TÊTE de mon pack. */
async function ajouterAMonPack(userId: string, assetId: bigint, emoji: string) {
  const pack = await monPack(userId, true);
  if (!pack) throw new ErreurStickers(500, "SERVER_ERROR", "Pack personnel indisponible");
  const deja = await prisma.sticker.findFirst({ where: { packId: pack.id, assetId } });
  if (deja) return { stickerId: Number(deja.id), packId: Number(pack.id), reutilise: true };
  if ((await prisma.sticker.count({ where: { packId: pack.id } })) >= CREATIONS_MAX) {
    throw new ErreurStickers(409, "STICKER_PACK_FULL", `${CREATIONS_MAX} stickers au plus`);
  }
  const premier = await prisma.sticker.aggregate({ where: { packId: pack.id }, _min: { position: true } });
  const s = await prisma.sticker.create({
    data: { packId: pack.id, assetId, emoji, position: (premier._min.position ?? 1) - 1 },
  });
  await prisma.stickerPack.update({ where: { id: pack.id }, data: { modifieLe: new Date(), version: { increment: 1 } } });
  return { stickerId: Number(s.id), packId: Number(pack.id), reutilise: false };
}

/** `POST /api/stickers/assets` — multipart `file` (PNG/WebP ≤ 1 Mo, ≤ 1024 px), `emoji` facultatif. */
export async function creerSticker(userId: string, form: FormData | null) {
  await exigerCreation();
  const quota = await rateLimit(`sticker-creation:${userId}`, CREATIONS_PAR_HEURE, 60 * 60_000);
  if (!quota.allowed) throw new ErreurStickers(429, "RATE_LIMITED", "Trop de stickers créés, réessayez plus tard");
  const f = form?.get("file");
  if (!f || typeof f !== "object" || !("arrayBuffer" in f)) {
    throw new ErreurStickers(422, "STICKER_ASSET_INVALID", "Fichier PNG ou WebP requis");
  }
  if ((f as File).size > OCTETS_MAX) throw new ErreurStickers(413, "STICKER_ASSET_TOO_LARGE", "1 Mo au plus");
  const octets = Buffer.from(await (f as File).arrayBuffer());
  const image = lireImage(octets);
  if (!image) throw new ErreurStickers(422, "STICKER_ASSET_INVALID", "Fichier PNG ou WebP requis");
  if (image.largeur < 1 || image.hauteur < 1 || image.largeur > COTE_MAX || image.hauteur > COTE_MAX) {
    throw new ErreurStickers(422, "STICKER_ASSET_INVALID", `${COTE_MAX} pixels de côté au plus`);
  }
  const emoji = String(form?.get("emoji") ?? "").trim().slice(0, 16);

  const empreinte = createHash("sha256").update(octets).digest("hex");
  let asset = await prisma.stickerAsset.findUnique({ where: { empreinte } });
  if (asset && asset.statut !== 0) throw new ErreurStickers(422, "STICKER_ASSET_INVALID", "Image retirée par la modération");
  if (!asset) {
    const { relativeUrl, espace } = await saveBuffer(octets, "sticker", image.mime, "public");
    asset = await prisma.stickerAsset.create({
      data: { url: relativeUrl, espace: espace === "public" ? "public" : null, mime: image.mime, octets: octets.length, empreinte, anime: false },
    });
  }
  const r = await ajouterAMonPack(userId, asset.id, emoji);
  return { ...r, assetId: Number(asset.id) };
}

/** `DELETE /api/stickers/stickers/:id` — retire une de MES créations (idempotent). */
export async function supprimerCreation(userId: string, brut: string) {
  await exigerCreation();
  if (!/^\d{1,18}$/.test(brut)) return;
  await prisma.sticker.deleteMany({ where: { id: BigInt(brut), pack: { proprietaireId: userId } } });
}

/** `POST /api/stickers/stickers/:id/copy` — garde chez moi un sticker reçu. */
export async function copierSticker(userId: string, brut: string) {
  await exigerCreation();
  const s =
    /^\d{1,18}$/.test(brut) &&
    (await prisma.sticker.findUnique({ where: { id: BigInt(brut) }, include: { asset: true, pack: true } }));
  if (!s || s.asset.statut !== 0 || s.pack.statut === 0) {
    throw new ErreurStickers(404, "STICKER_NOT_FOUND", "Sticker introuvable");
  }
  const r = await ajouterAMonPack(userId, s.assetId, s.emoji);
  return { ...r, assetId: Number(s.assetId) };
}
