-- =============================================================
-- Ajouts de James : suppression logique et réinitialisation admin
-- =============================================================
-- Repris tel quel de son `schema-copie.prisma`, sans modification.
--
-- Strictement additif : aucune colonne existante n'est touchée, rien n'est
-- renommé ni supprimé. Les `isDelete` sont NOT NULL avec défaut `false`, donc
-- l'ajout est immédiat même sur `users` (46 lignes) — depuis PostgreSQL 11 un
-- défaut ne réécrit pas la table.
--
-- ⚠️ REMARQUE À REMONTER À L'ÉQUIPE, pas un blocage. `users` porte désormais
-- TROIS notions d'inactivité : `actif` (l'utilisateur se désactive), `exclus`
-- (décision d'administration, avec `exclude_at`/`exclude_reason`) et
-- `isDelete` (effacement). Rien dans le schéma ne dit laquelle fait foi, et
-- une requête qui en oublie une renverra des comptes qu'elle ne devrait pas.
-- Même situation sur `service`, qui a déjà `deleted`.
--
-- Application : psql -h localhost -U alanyavox -d alanya -v ON_ERROR_STOP=1 \
--                    -f prisma/manual/2026-07_james_soft_delete.sql

-- -------------------------------------------------------------
-- 1. Suppression logique
-- -------------------------------------------------------------
ALTER TABLE "users"          ADD COLUMN IF NOT EXISTS "isDelete" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "pays"           ADD COLUMN IF NOT EXISTS "isDelete" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ville"          ADD COLUMN IF NOT EXISTS "isDelete" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "prixabonnement" ADD COLUMN IF NOT EXISTS "isDelete" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "abonnement"     ADD COLUMN IF NOT EXISTS "isDelete" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "agence"         ADD COLUMN IF NOT EXISTS "isDelete" BOOLEAN NOT NULL DEFAULT false;

-- -------------------------------------------------------------
-- 2. Description d'un tarif d'abonnement
-- -------------------------------------------------------------
ALTER TABLE "prixabonnement" ADD COLUMN IF NOT EXISTS "description" TEXT;

-- -------------------------------------------------------------
-- 3. Réinitialisation de mot de passe du back-office
-- -------------------------------------------------------------
-- Nullable des deux côtés : un jeton n'existe que pendant une demande en cours.
ALTER TABLE "adminroot" ADD COLUMN IF NOT EXISTS "reset_password_token"   VARCHAR(255);
ALTER TABLE "adminroot" ADD COLUMN IF NOT EXISTS "reset_password_expires" TIMESTAMPTZ(6);
ALTER TABLE "admin"     ADD COLUMN IF NOT EXISTS "reset_password_token"   VARCHAR(255);
ALTER TABLE "admin"     ADD COLUMN IF NOT EXISTS "reset_password_expires" TIMESTAMPTZ(6);
