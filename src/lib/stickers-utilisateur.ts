import { prisma } from "@/lib/prisma";
import { lireReglage } from "@/lib/gestion/outils";
import { creationOuverte, mesCreations } from "@/lib/stickers-perso";

/**
 * LES STICKERS DE CHACUN (24/10/2026, demande du user : « comme WhatsApp »).
 *
 * Le catalogue (`GET /api/stickers`) dit ce qui EXISTE ; ce module dit ce que
 * CE compte a dans son panneau — ses packs, dans son ordre, et ses favoris —
 * commun à ses appareils, mobile et web. Les routes sont celles du contrat
 * d'Alanya2026 (`/api/stickers/me…`).
 *
 * Les récents, eux, restent sur l'appareil : WhatsApp ne les synchronise pas.
 *
 * ⚠️ PREMIÈRE LECTURE = TOUS LES PACKS PUBLIÉS. Un compte qui n'a encore
 * aucune ligne n'a jamais ouvert ses stickers : il reçoit tout le catalogue,
 * comme les packs fournis d'office par WhatsApp. Un pack retiré garde sa
 * ligne (`installe = false`) : ce cadeau ne se fait qu'une fois, et un pack
 * publié plus tard s'ajoute depuis la boutique.
 */

export const MAX_PACKS_INSTALLES = 50;
export const MAX_FAVORIS = 300;

export class ErreurStickers extends Error {
  constructor(
    readonly statut: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Les stickers sont-ils ouverts par la console ? Fermés, tout répond 404. */
export async function stickersOuverts(): Promise<{ ouverts: boolean; animes: boolean }> {
  const r = await lireReglage("stickers", { enabled: false, animatedEnabled: true });
  return { ouverts: r.valeur.enabled === true, animes: r.valeur.animatedEnabled !== false };
}

async function exigerOuverts() {
  const r = await stickersOuverts();
  if (!r.ouverts) throw new ErreurStickers(404, "NOT_FOUND", "Introuvable");
  return r;
}

/** `GET /api/stickers/me` — `{ packs: [{id, code, position}], favorites: [id] }`. */
export async function mesStickers(userId: string) {
  const { animes } = await exigerOuverts();

  const aDesLignes = await prisma.stickerInstallation.count({ where: { userId } });
  if (aDesLignes === 0) {
    const publies = await prisma.stickerPack.findMany({
      where: { statut: 1, proprietaireId: null },
      orderBy: [{ ordre: "asc" }, { publieLe: "desc" }],
      select: { id: true },
    });
    if (publies.length) {
      await prisma.stickerInstallation.createMany({
        data: publies.slice(0, MAX_PACKS_INSTALLES).map((p, i) => ({ userId, packId: p.id, position: i })),
        skipDuplicates: true,
      });
    }
  }

  const [installes, favoris] = await Promise.all([
    prisma.stickerInstallation.findMany({
      where: { userId, installe: true, pack: { statut: 1, proprietaireId: null } },
      orderBy: [{ position: "asc" }, { modifieLe: "asc" }],
      include: { pack: { select: { code: true } } },
    }),
    prisma.stickerFavori.findMany({
      where: {
        userId,
        sticker: {
          pack: { statut: 1, OR: [{ proprietaireId: null }, { proprietaireId: userId }] },
          asset: { statut: 0, ...(animes ? {} : { anime: false }) },
        },
      },
      orderBy: { ajouteLe: "desc" },
      select: { stickerId: true },
    }),
  ]);
  // Création (25/10/2026) : ouverte ou non, et mes créations, dans le même
  // appel — le panneau s'ouvre sans second aller-retour.
  const creation = await creationOuverte();
  return {
    packs: installes.map((i, n) => ({ id: Number(i.packId), code: i.pack.code, position: n })),
    favorites: favoris.map((f) => Number(f.stickerId)),
    features: { creation },
    created: creation ? await mesCreations(userId) : null,
  };
}

const idPositif = (brut: string): bigint | null => (/^\d{1,18}$/.test(brut) && brut !== "0" ? BigInt(brut) : null);

/** `PUT /api/stickers/me/packs/:id` — idempotent ; le pack va en dernier. */
export async function installerPack(userId: string, brut: string) {
  await exigerOuverts();
  const id = idPositif(brut);
  const pack = id && (await prisma.stickerPack.findUnique({ where: { id }, select: { id: true, statut: true, proprietaireId: true } }));
  // Un pack « Mes créations » ne s'installe pas : il a sa propre place.
  if (!pack || pack.statut !== 1 || pack.proprietaireId !== null) {
    throw new ErreurStickers(404, "STICKER_PACK_UNAVAILABLE", "Pack de stickers indisponible");
  }
  const existant = await prisma.stickerInstallation.findUnique({ where: { userId_packId: { userId, packId: pack.id } } });
  if (existant?.installe) return;
  const nb = await prisma.stickerInstallation.count({ where: { userId, installe: true } });
  if (nb >= MAX_PACKS_INSTALLES) {
    throw new ErreurStickers(409, "STICKER_PACK_LIMIT", "Limite de packs installés atteinte");
  }
  const dernier = await prisma.stickerInstallation.aggregate({ where: { userId }, _max: { position: true } });
  const position = (dernier._max.position ?? -1) + 1;
  await prisma.stickerInstallation.upsert({
    where: { userId_packId: { userId, packId: pack.id } },
    create: { userId, packId: pack.id, position },
    update: { installe: true, position, modifieLe: new Date() },
  });
}

/** `DELETE /api/stickers/me/packs/:id` — idempotent. La ligne reste (voir l'en-tête). */
export async function retirerPack(userId: string, brut: string) {
  await exigerOuverts();
  const id = idPositif(brut);
  if (!id) throw new ErreurStickers(404, "STICKER_PACK_UNAVAILABLE", "Pack de stickers indisponible");
  // `upsert` et non `update` : retirer un pack AVANT la toute première lecture
  // ne doit pas le faire revenir au cadeau de bienvenue.
  await prisma.stickerInstallation.upsert({
    where: { userId_packId: { userId, packId: id } },
    create: { userId, packId: id, installe: false },
    update: { installe: false, modifieLe: new Date() },
  }).catch(() => {
    // Pack inexistant (clé étrangère) : rien à retirer.
  });
}

/** `PUT /api/stickers/me/packs/order` — `{ ids: [packId…] }`, l'ordre du panneau. */
export async function ordonnerPacks(userId: string, brut: unknown) {
  await exigerOuverts();
  const ids = (brut as { ids?: unknown })?.ids;
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_PACKS_INSTALLES ||
    !ids.every((n) => Number.isSafeInteger(n) && (n as number) > 0)
  ) {
    throw new ErreurStickers(400, "STICKER_INVALID_PAYLOAD", "ids : liste d'identifiants de packs");
  }
  await prisma.$transaction(
    (ids as number[]).map((id, position) =>
      prisma.stickerInstallation.updateMany({ where: { userId, packId: BigInt(id) }, data: { position } }),
    ),
  );
}

/** `PUT /api/stickers/me/favorites/:stickerId` — un sticker disponible seulement. */
export async function ajouterFavori(userId: string, brut: string) {
  const { animes } = await exigerOuverts();
  const id = idPositif(brut);
  const s =
    id &&
    (await prisma.sticker.findUnique({
      where: { id },
      select: {
        id: true,
        pack: { select: { statut: true, proprietaireId: true } },
        asset: { select: { statut: true, anime: true } },
      },
    }));
  // Un sticker officiel publié, ou l'une de MES créations — pas celle d'un autre.
  const accessible = s && (s.pack.proprietaireId === null || s.pack.proprietaireId === userId);
  if (!s || !accessible || s.pack.statut !== 1 || s.asset.statut !== 0 || (s.asset.anime && !animes)) {
    throw new ErreurStickers(404, "STICKER_NOT_FOUND", "Sticker introuvable");
  }
  const deja = await prisma.stickerFavori.findUnique({ where: { userId_stickerId: { userId, stickerId: s.id } } });
  if (deja) return;
  if ((await prisma.stickerFavori.count({ where: { userId } })) >= MAX_FAVORIS) {
    throw new ErreurStickers(409, "STICKER_FAVORITES_LIMIT", "Limite de favoris atteinte");
  }
  await prisma.stickerFavori.create({ data: { userId, stickerId: s.id } });
}

/** `DELETE /api/stickers/me/favorites/:stickerId` — idempotent. */
export async function retirerFavori(userId: string, brut: string) {
  await exigerOuverts();
  const id = idPositif(brut);
  if (!id) return;
  await prisma.stickerFavori.deleteMany({ where: { userId, stickerId: id } });
}
