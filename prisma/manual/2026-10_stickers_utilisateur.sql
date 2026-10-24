-- Stickers côté utilisateur (24/10/2026, demande du user : « comme WhatsApp »).
--
-- 1. Le type de message STICKER : charge JSON dans `content` (fil en clair) ou
--    dans l'enveloppe chiffrée (`src/lib/message-payload.mjs`).
-- 2. Les packs que chacun a dans son panneau (« Mes stickers »).
-- 3. Ses favoris, communs à ses appareils.
--
-- ⚠️ `ALTER TYPE … ADD VALUE` ne s'annule pas : à jouer HORS transaction, une
-- seule fois (IF NOT EXISTS le rend rejouable).

ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'STICKER';

CREATE TABLE IF NOT EXISTS sticker_installation (
  user_id    uuid        NOT NULL REFERENCES users("alanyaID") ON DELETE CASCADE,
  pack_id    bigint      NOT NULL REFERENCES sticker_pack(id) ON DELETE CASCADE,
  installe   boolean     NOT NULL DEFAULT true,
  position   integer     NOT NULL DEFAULT 0,
  modifie_le timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pack_id)
);

CREATE TABLE IF NOT EXISTS sticker_favori (
  user_id    uuid        NOT NULL REFERENCES users("alanyaID") ON DELETE CASCADE,
  sticker_id bigint      NOT NULL REFERENCES sticker(id) ON DELETE CASCADE,
  ajoute_le  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sticker_id)
);
