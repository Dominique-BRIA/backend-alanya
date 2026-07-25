-- Lot Favoris — Messages favoris (étoile).
-- Migration ADDITIVE et NON DESTRUCTIVE (CREATE TABLE / INDEX uniquement).
-- À exécuter UNE FOIS sur la base Neon, puis redéployer le backend.

CREATE TABLE IF NOT EXISTS message_stars (
  id          uuid        PRIMARY KEY,
  message_id  uuid        NOT NULL,
  user_id     uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_stars_message_fk
    FOREIGN KEY (message_id) REFERENCES message("msgID")   ON DELETE CASCADE,
  CONSTRAINT message_stars_user_fk
    FOREIGN KEY (user_id)    REFERENCES users("alanyaID")  ON DELETE CASCADE,
  CONSTRAINT message_stars_unique UNIQUE (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS message_stars_user_id_idx
  ON message_stars (user_id);
