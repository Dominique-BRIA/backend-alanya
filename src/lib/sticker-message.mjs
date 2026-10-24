/**
 * UN STICKER ENVOYÉ EN CLAIR (24/10/2026) — contrôle et forme canonique,
 * PARTAGÉS par les deux chemins d'envoi : `creerMessage` (HTTP) et
 * `handleSend` (temps réel, `ws-server.mjs`). Une règle ajoutée ici arrive
 * des deux côtés, comme chez Alanya2026 (`utils/stickerMessage.js`).
 *
 * Le client n'est cru que sur `sid` : le pack, l'image, l'émoji et le
 * caractère animé sont RELUS en base, et la charge est réécrite.
 *
 * ── Trois refus, trois codes ──
 *
 *   - stickers fermés par la console, charge illisible → STICKER_INVALID_PAYLOAD
 *     (rien n'est révélé) ;
 *   - sticker inconnu, image retirée, animé alors que les animés sont fermés
 *     → STICKER_NOT_FOUND ;
 *   - pack non publié (brouillon, archivé) → STICKER_PACK_UNAVAILABLE.
 *
 * ── E2EE ──
 *
 * Dans un fil chiffré, la charge est dans l'enveloppe : le serveur ne peut
 * rien vérifier et ne touche à rien. Ce contrôle ne s'applique qu'au clair.
 *
 * ⚠️ Fichier `.mjs` sans import TypeScript : `ws-server.mjs` le charge tel quel.
 */
import { chargeSticker, litSticker } from "./message-payload.mjs";

/** Clé des réglages de la console (`src/lib/gestion/stickers.ts`). */
const CLE_REGLAGES = "stickers";

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string|null|undefined} content
 * @returns {Promise<{ok: true, contenu: string} | {ok: false, code: string}>}
 */
export async function stickerPourEnvoi(prisma, content) {
  const lu = litSticker(content);
  if (!lu) return { ok: false, code: "STICKER_INVALID_PAYLOAD" };

  const reglage = await prisma.gestionReglage.findUnique({ where: { cle: CLE_REGLAGES } });
  const r = { enabled: false, animatedEnabled: true, ...(reglage?.valeur ?? {}) };
  if (!r.enabled) return { ok: false, code: "STICKER_INVALID_PAYLOAD" };

  const s = await prisma.sticker.findUnique({
    where: { id: BigInt(lu.sid) },
    include: { asset: true, pack: true },
  });
  if (!s || s.asset.statut !== 0) return { ok: false, code: "STICKER_NOT_FOUND" };
  if (s.asset.anime && !r.animatedEnabled) return { ok: false, code: "STICKER_NOT_FOUND" };
  if (s.pack.statut !== 1) return { ok: false, code: "STICKER_PACK_UNAVAILABLE" };

  return {
    ok: true,
    contenu: chargeSticker({
      pack: s.pack.code,
      sid: Number(s.id),
      asset: Number(s.assetId),
      emoji: s.emoji,
      w: 512,
      h: 512,
      a: s.asset.anime ? 1 : 0,
    }),
  };
}
