-- =============================================================
-- Champ « agent » sur Appareil + table « customerChat »
-- =============================================================
-- Additif et idempotent : rejouable sans risque, y compris par
-- scripts/apply-manual-sql.sh au déploiement.
--
-- Les noms physiques (« ID », « AlanyaID », « start_time », majuscules)
-- reprennent exactement le référentiel, d'où les guillemets. Les noms de champ
-- Prisma restent en camelCase via @map — même approche que l'harmonisation.
--
-- Application : psql -h localhost -U alanyavox -d alanya -v ON_ERROR_STOP=1 \
--                    -f prisma/manual/2026-07_customer_chat.sql

-- -------------------------------------------------------------
-- 1. Appareil.agent
-- -------------------------------------------------------------
-- Nullable à dessein : les lignes déjà en base n'ont pas d'agent, et leur
-- imposer un défaut inventé inscrirait une information fausse là où elle est
-- simplement absente.
--
-- Nommée « agent », comme le référentiel équipe (schéma du 05/08/2026). Elle
-- avait été renommée « nomAgent » le 29/07, puis ramenée à son nom d'origine
-- le 05/08 pour rejoindre le référentiel. Voir 2026-07_rapport_chat.sql, qui
-- effectue le renommage sur les bases déjà créées ; ce fichier-ci décrit l'état
-- cible, pour qu'une base neuve soit construite directement au bon nom. Le
-- laisser à « nomAgent » recréerait la colonne à chaque déploiement, en
-- doublon de « agent ».
-- -------------------------------------------------------------
-- 0. Renommages préalables — À LIRE AVANT DE MODIFIER CE FICHIER
-- -------------------------------------------------------------
-- Ces deux renommages figurent AUSSI dans 2026-07_rapport_chat.sql. Ils sont
-- répétés ici, et en TÊTE, parce que `apply-manual-sql.sh` rejoue les
-- fichiers par ordre alphabétique : « customer » passe avant « rapport ». Sans
-- eux, ce fichier-ci s'exécuterait sur une base portant encore les anciens
-- noms, et les deux instructions qui suivent seraient fausses :
--
--   • `ADD COLUMN IF NOT EXISTS "agent"` créerait une SECONDE colonne, en
--     doublon de « nomAgent » — le piège classique de `IF NOT EXISTS`, qui
--     ne compare que le nom ;
--   • `CREATE INDEX … ON "customerChat"("AlanyaID")` échouerait, la colonne
--     s'appelant encore « customerID ».
--
-- Être idempotents, ils ne coûtent rien sur une base déjà à jour.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'Appareil' AND column_name = 'nomAgent')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'Appareil' AND column_name = 'agent')
  THEN
    ALTER TABLE "Appareil" RENAME COLUMN "nomAgent" TO "agent";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'customerChat' AND column_name = 'customerID')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'customerChat' AND column_name = 'AlanyaID')
  THEN
    ALTER TABLE "customerChat" RENAME COLUMN "customerID" TO "AlanyaID";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customerChat_customerID_fkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customerChat_AlanyaID_fkey')
  THEN
    ALTER TABLE "customerChat" RENAME CONSTRAINT "customerChat_customerID_fkey" TO "customerChat_AlanyaID_fkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'customerChat_customerID_start_idx')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'customerChat_AlanyaID_start_idx')
  THEN
    ALTER INDEX "customerChat_customerID_start_idx" RENAME TO "customerChat_AlanyaID_start_idx";
  END IF;
END $$;

ALTER TABLE "Appareil"
  ADD COLUMN IF NOT EXISTS "agent" VARCHAR(50);

-- -------------------------------------------------------------
-- 2. customerChat
-- -------------------------------------------------------------
-- Une ligne par session de discussion client, ouverte à « start_time » et
-- refermée à « end_time ». Un « end_time » nul vaut « session en cours » :
-- inutile d'ajouter une colonne d'état, qui pourrait diverger de la réalité.
--
-- « isFree » suit la convention du projet pour les booléens (SMALLINT 0/1,
-- comme « is_online » ou « destroy ») plutôt qu'un BOOLEAN natif.
--
-- Les deux clés étrangères sont en ON DELETE CASCADE pour que la suppression
-- de compte (DELETE /api/account) reste possible : une contrainte RESTRICT
-- ferait échouer la suppression dès qu'une session existerait.
-- « AlanyaID » : nom du référentiel équipe. La colonne avait été renommée
-- « customerID » le 29/07 pour la distinguer de l'agent qui est à l'autre bout
-- de la discussion ; le référentiel du 05/08 revient au nom d'origine, et c'est
-- lui qui fait foi.
CREATE TABLE IF NOT EXISTS "customerChat" (
  "ID"         SERIAL PRIMARY KEY,
  "appareilID" INTEGER        NOT NULL,
  "AlanyaID"   UUID           NOT NULL,
  "start_time" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "end_time"   TIMESTAMPTZ(6),
  "isFree"     SMALLINT       NOT NULL DEFAULT 1,
  CONSTRAINT "customerChat_appareilID_fkey"
    FOREIGN KEY ("appareilID") REFERENCES "Appareil"("appareilID") ON DELETE CASCADE,
  CONSTRAINT "customerChat_AlanyaID_fkey"
    FOREIGN KEY ("AlanyaID") REFERENCES "users"("alanyaID") ON DELETE CASCADE
);

-- Les sessions d'un client, la plus récente d'abord. Son préfixe gauche couvre
-- aussi les recherches sur le seul « customerID » — un second index sur cette
-- colonne serait redondant.
CREATE INDEX IF NOT EXISTS "customerChat_AlanyaID_start_idx"
  ON "customerChat"("AlanyaID", "start_time" DESC);

-- PostgreSQL n'indexe PAS automatiquement les clés étrangères. Sans cet index,
-- chaque suppression d'appareil imposerait un parcours complet de customerChat
-- pour vérifier la cascade.
CREATE INDEX IF NOT EXISTS "customerChat_appareilID_idx"
  ON "customerChat"("appareilID");
