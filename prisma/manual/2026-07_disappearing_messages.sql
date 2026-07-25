-- Lot 2.6 — Messages éphémères (minuteur au niveau conversation).
-- Migration ADDITIVE et NON DESTRUCTIVE (ADD COLUMN / INDEX).
-- À exécuter UNE FOIS sur la base Neon, puis redéployer le backend.

ALTER TABLE conversation
  ADD COLUMN IF NOT EXISTS disappearing_seconds integer NOT NULL DEFAULT 0;

ALTER TABLE message
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS message_expires_at_idx
  ON message (expires_at);
