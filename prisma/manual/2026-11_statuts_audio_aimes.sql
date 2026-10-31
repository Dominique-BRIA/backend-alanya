-- STATUTS AUDIO ET « J'AIME » (01/11/2026).
--
-- Repris d'Alanya (dépôt de référence, migration 004_status_likes_audio) :
--  - un quatrième type de statut, AUDIO, avec sa durée (aussi utile à la vidéo) ;
--  - le « J'aime », porté par la vue : on n'aime que ce qu'on a vu.
ALTER TYPE "StatusType" ADD VALUE IF NOT EXISTS 'AUDIO';

ALTER TABLE "statut"
    ADD COLUMN IF NOT EXISTS "media_duration_ms" INTEGER;

ALTER TABLE "statut_views"
    ADD COLUMN IF NOT EXISTS "liked" BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS "liked_at" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "idx_statut_views_aimes"
    ON "statut_views" ("statutID") WHERE "liked";
