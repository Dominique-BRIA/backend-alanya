-- Lot Épingler — message épinglé par conversation.
-- Migration ADDITIVE et NON DESTRUCTIVE (ALTER TABLE ADD COLUMN).
-- À exécuter UNE FOIS sur la base Neon, puis redéployer le backend.

ALTER TABLE conversation
  ADD COLUMN IF NOT EXISTS pinned_message_id uuid;
