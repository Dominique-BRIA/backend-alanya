-- GROUPES : PROPRIÉTAIRE, RÉGLAGES, ARRIVÉE, SOURDINE (01/11/2026).
--
-- Repris du dépôt de référence Alanya2026. Tout est ADDITIF, et les valeurs
-- par défaut gardent le fonctionnement d'avant : tout le monde écrit, seuls
-- les admins modifient le groupe et ajoutent des membres, l'historique reste
-- visible, personne n'a de bannière d'arrivée à confirmer.
--
-- Rejouable sans effet : chaque instruction est conditionnelle.

ALTER TABLE "conversation"
    ADD COLUMN IF NOT EXISTS "description" VARCHAR(512),
    ADD COLUMN IF NOT EXISTS "proprietaire_id" UUID,
    ADD COLUMN IF NOT EXISTS "admins_seuls_ecrivent" BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS "admins_seuls_modifient" BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS "admins_seuls_ajoutent" BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS "historique_cache_nouveaux" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "conv_participants"
    ADD COLUMN IF NOT EXISTS "arrivee_a_confirmer" BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS "historique_depuis" TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS "sourdine_jusqu_a" TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS "mentions_seulement" BOOLEAN NOT NULL DEFAULT FALSE;

-- LE PROPRIÉTAIRE DES GROUPES EXISTANTS : leur admin le plus ancien encore
-- membre. Un groupe sans admin reste sans propriétaire — les règles d'avant
-- s'y appliquent (le premier membre fait office d'admin).
UPDATE "conversation" c
SET "proprietaire_id" = x."alanyaID"
FROM (
    SELECT DISTINCT ON (p."conversID") p."conversID", p."alanyaID"
    FROM "conv_participants" p
    WHERE p."role" = 'ADMIN' AND p."est_membre"
    ORDER BY p."conversID", p."joinedAt" ASC
) x
WHERE c."conversID" = x."conversID"
  AND c."isGroup"
  AND c."proprietaire_id" IS NULL;
