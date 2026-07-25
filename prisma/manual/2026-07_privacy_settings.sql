-- Lot 3.1 — Confidentialité (confirmations de lecture + visibilité « vu à »).
-- Migration ADDITIVE et NON DESTRUCTIVE (ADD COLUMN).
-- À exécuter UNE FOIS sur la base Neon, puis redéployer le backend.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS read_receipts smallint NOT NULL DEFAULT 1;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_seen_visibility smallint NOT NULL DEFAULT 2;
