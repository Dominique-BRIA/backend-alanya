-- ---------------------------------------------------------------------------
-- ESPACE DÉVELOPPEUR : PASSAGE AUX ENSEIGNES (07/11/2026)
-- ---------------------------------------------------------------------------
--
-- Décisions du user (07/11/2026) :
--   - une clé API appartient à une ENSEIGNE, qui a son propre compte Alanya
--     (type 6) et son propre numéro : c'est elle qui envoie les messages ;
--   - TOUS les comptes développeurs d'avant (des comptes personnels qui
--     envoyaient en leur propre nom) sont supprimés ;
--   - la base de la gestion développeur peut être nettoyée librement.
--
-- ⚠️ REJOUABLE, comme tous les fichiers de ce dossier (`deployer.sh` les
-- rejoue à chaque déploiement). La suppression des anciens comptes ne vise que
-- les lignes SANS propriétaire, et la colonne devient aussitôt NOT NULL : au
-- second passage, il n'en reste plus aucune, et le DELETE ne fait plus rien.
--
-- Ce qui disparaît avec les anciens comptes, par cascade : leurs clés, leur
-- journal, leur webhook, leurs codes de vérification. Les comptes Alanya des
-- personnes ne sont PAS touchés.

-- 1. La propriétaire de l'enseigne : la personne qui la gère.
ALTER TABLE "developer_accounts" ADD COLUMN IF NOT EXISTS "proprietaire_id" UUID;

DELETE FROM "developer_accounts" WHERE "proprietaire_id" IS NULL;

ALTER TABLE "developer_accounts" ALTER COLUMN "proprietaire_id" SET NOT NULL;

DO $$ BEGIN
    ALTER TABLE "developer_accounts"
        ADD CONSTRAINT "developer_accounts_proprietaire_id_fkey"
        FOREIGN KEY ("proprietaire_id") REFERENCES "users"("alanyaID") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "developer_accounts_proprietaire_idx" ON "developer_accounts"("proprietaire_id");

-- 2. Les tables mortes : facturation, anciens codes, anciens médias, espaces
--    de travail (remplacés par les enseignes).
DROP TABLE IF EXISTS "developer_ledgers";
DROP TABLE IF EXISTS "developer_otps";
DROP TABLE IF EXISTS "developer_medias";

ALTER TABLE "developer_api_keys" DROP COLUMN IF EXISTS "workspace_id";
ALTER TABLE "developer_api_logs" DROP COLUMN IF EXISTS "workspace_id";
DROP TABLE IF EXISTS "developer_workspaces";

DROP TYPE IF EXISTS "TransactionType";
DROP TYPE IF EXISTS "TransactionStatus";

-- 3. Les colonnes mortes : solde, type Sandbox/Production, jeton jamais lu.
ALTER TABLE "developer_accounts" DROP COLUMN IF EXISTS "balance_credits";
ALTER TABLE "developer_accounts" DROP COLUMN IF EXISTS "hold_credits";
ALTER TABLE "developer_api_keys" DROP COLUMN IF EXISTS "type";
DROP TYPE IF EXISTS "ApiKeyType";
ALTER TABLE "developer_webhooks" DROP COLUMN IF EXISTS "verify_token";

-- 4. Un code vivant par ENSEIGNE, destination et finalité — et non plus par
--    destination et finalité seulement. Avant, le code demandé par une
--    enseigne périmait celui qu'une autre venait d'envoyer à la même personne.
--    Le nouvel index est créé par `2026-08_verification.sql`, qui décrit
--    l'état cible et passe avant ce fichier.
DROP INDEX IF EXISTS "verification_un_seul_vivant_idx";
