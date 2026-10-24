-- =============================================================
-- CONSOLE DE GESTION — les médias déposés par la console (24/10/2026)
-- =============================================================
-- Images et vidéos de la bienvenue, des statuts de bienvenue et des
-- diffusions (`POST /api/upload/media`, comme chez Alanya2026). Le fichier
-- est une ligne `media_files` comme une autre ; CETTE table dit qu'il a été
-- déposé par la console, et donc qu'il peut être servi sans jeton
-- (`GET /api/upload/media/:id`) — un contenu officiel, destiné à tous.
--
-- ⚠️ Un média d'utilisateur n'est JAMAIS servi par cette route : seul ce qui
-- figure ici l'est.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

CREATE TABLE IF NOT EXISTS "gestion_media" (
  "media_id"  UUID         PRIMARY KEY,
  "cree_par"  VARCHAR(64)  NOT NULL,
  "cree_le"   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
