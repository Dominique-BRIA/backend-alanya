-- Lot 2.2 — Réactions emoji.
-- Migration ADDITIVE et NON DESTRUCTIVE (CREATE TABLE / INDEX uniquement).
-- À exécuter UNE FOIS sur la base Neon (console SQL), puis redéployer le backend.
-- Rappel : on n'utilise pas `prisma migrate deploy` (Neon harmonisée manuellement).

CREATE TABLE IF NOT EXISTS message_reactions (
  id          uuid        PRIMARY KEY,
  message_id  uuid        NOT NULL,
  user_id     uuid        NOT NULL,
  emoji       varchar(16) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_reactions_message_fk
    FOREIGN KEY (message_id) REFERENCES message("msgID")   ON DELETE CASCADE,
  CONSTRAINT message_reactions_user_fk
    FOREIGN KEY (user_id)    REFERENCES users("alanyaID")  ON DELETE CASCADE,
  CONSTRAINT message_reactions_unique UNIQUE (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS message_reactions_message_id_idx
  ON message_reactions (message_id);
