-- =============================================================
-- Renommages centre d'appels + tables rapportChat / docRapport
-- =============================================================
-- ATTENTION : contrairement aux migrations précédentes, celle-ci touche des
-- tables QUI CONTIENNENT DÉJÀ DES DONNÉES (20 appareils, 46 comptes au
-- 29/07/2026). Les renommages se font par ALTER ... RENAME, qui préserve
-- intégralement le contenu — jamais par DROP puis CREATE.
--
-- Un renommage de colonne conserve automatiquement ses index et contraintes :
-- PostgreSQL les rattache par identifiant interne, pas par nom. Seuls leurs
-- NOMS deviennent trompeurs, d'où les ALTER INDEX / RENAME CONSTRAINT qui
-- suivent chaque renommage.
--
-- Idempotent : chaque étape vérifie l'état avant d'agir, donc le script peut
-- être rejoué (apply-manual-sql.sh le lance à chaque déploiement).
--
-- Application : psql -h localhost -U alanyavox -d alanya -v ON_ERROR_STOP=1 \
--                    -f prisma/manual/2026-07_rapport_chat.sql

-- -------------------------------------------------------------
-- 1. Appareil.agent  →  Appareil.nomAgent
-- -------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'Appareil' AND column_name = 'agent')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'Appareil' AND column_name = 'nomAgent')
  THEN
    ALTER TABLE "Appareil" RENAME COLUMN "agent" TO "nomAgent";
  END IF;
END $$;

-- -------------------------------------------------------------
-- 2. Appareil.alanyaID  →  Appareil.idAgent
-- -------------------------------------------------------------
-- Le registre des appareils sert désormais le centre d'appels : la colonne
-- désigne l'agent propriétaire. La clé étrangère continue de pointer vers
-- users(alanyaID), qui ne bouge pas.
--
-- ⚠️ Cette colonne n'est PAS unique — un agent possède plusieurs appareils
-- (constaté : 20 appareils pour 7 comptes). Aucune clé étrangère ne peut donc
-- la cibler ; c'est pourquoi rapportChat.idAgent référence users(alanyaID).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'Appareil' AND column_name = 'alanyaID')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'Appareil' AND column_name = 'idAgent')
  THEN
    ALTER TABLE "Appareil" RENAME COLUMN "alanyaID" TO "idAgent";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Appareil_alanyaID_fkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Appareil_idAgent_fkey')
  THEN
    ALTER TABLE "Appareil" RENAME CONSTRAINT "Appareil_alanyaID_fkey" TO "Appareil_idAgent_fkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Appareil_cookies_alanyaID_key')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Appareil_cookies_idAgent_key')
  THEN
    ALTER INDEX "Appareil_cookies_alanyaID_key" RENAME TO "Appareil_cookies_idAgent_key";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Appareil_alanyaID_destroy_idx')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Appareil_idAgent_destroy_idx')
  THEN
    ALTER INDEX "Appareil_alanyaID_destroy_idx" RENAME TO "Appareil_idAgent_destroy_idx";
  END IF;
END $$;

-- -------------------------------------------------------------
-- 3. customerChat.AlanyaID  →  customerChat.customerID
-- -------------------------------------------------------------
-- Distingue le client de l'agent, qui est à l'autre bout de la discussion.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'customerChat' AND column_name = 'AlanyaID')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'customerChat' AND column_name = 'customerID')
  THEN
    ALTER TABLE "customerChat" RENAME COLUMN "AlanyaID" TO "customerID";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customerChat_AlanyaID_fkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customerChat_customerID_fkey')
  THEN
    ALTER TABLE "customerChat" RENAME CONSTRAINT "customerChat_AlanyaID_fkey" TO "customerChat_customerID_fkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'customerChat_AlanyaID_start_idx')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'customerChat_customerID_start_idx')
  THEN
    ALTER INDEX "customerChat_AlanyaID_start_idx" RENAME TO "customerChat_customerID_start_idx";
  END IF;
END $$;

-- -------------------------------------------------------------
-- 4. customerChat.isResolved
-- -------------------------------------------------------------
-- Vrai BOOLEAN, contrairement à « isFree » qui suit la convention SMALLINT 0/1
-- du référentiel. Écart assumé : le booléen a été demandé explicitement.
ALTER TABLE "customerChat"
  ADD COLUMN IF NOT EXISTS "isResolved" BOOLEAN NOT NULL DEFAULT false;

-- -------------------------------------------------------------
-- 5. users.appareil_total
-- -------------------------------------------------------------
-- Colonne du référentiel équipe (Prisma : appareilTotal). NOT NULL avec défaut :
-- depuis PostgreSQL 11 cela ne réécrit pas la table, l'opération est immédiate
-- même sur les 46 lignes existantes.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "appareil_total" SMALLINT NOT NULL DEFAULT 1;

-- -------------------------------------------------------------
-- 6. rapportChat  →  customerChat, users
-- -------------------------------------------------------------
-- « idAgent » référence users(alanyaID) et NON Appareil.idAgent : cette
-- dernière n'est pas unique, PostgreSQL refuserait la contrainte. La valeur est
-- la même, prise à sa source — et le rapport reste rattaché à l'agent même
-- lorsqu'il change de poste.
--
-- « date » est entre guillemets : c'est aussi un nom de type SQL.
CREATE TABLE IF NOT EXISTS "rapportChat" (
  "idRapport"  SERIAL PRIMARY KEY,
  "idCustomer" INTEGER        NOT NULL,
  "idAgent"    UUID           NOT NULL,
  "resume"     TEXT,
  "subject"    VARCHAR(200),
  "date"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "type"       SMALLINT,
  CONSTRAINT "rapportChat_idCustomer_fkey"
    FOREIGN KEY ("idCustomer") REFERENCES "customerChat"("ID") ON DELETE CASCADE,
  CONSTRAINT "rapportChat_idAgent_fkey"
    FOREIGN KEY ("idAgent") REFERENCES "users"("alanyaID") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "rapportChat_idCustomer_idx"
  ON "rapportChat"("idCustomer");

-- Les rapports d'un agent, du plus récent au plus ancien.
CREATE INDEX IF NOT EXISTS "rapportChat_idAgent_date_idx"
  ON "rapportChat"("idAgent", "date" DESC);

-- -------------------------------------------------------------
-- 7. docRapport  →  rapportChat
-- -------------------------------------------------------------
-- « url » en TEXT et non VARCHAR(255) : une URL signée de stockage objet
-- dépasse couramment 255 caractères, et la tronquer la rendrait inutilisable.
CREATE TABLE IF NOT EXISTS "docRapport" (
  "idDoc"     SERIAL PRIMARY KEY,
  "idRapport" INTEGER NOT NULL,
  "url"       TEXT    NOT NULL,
  "type"      SMALLINT,
  CONSTRAINT "docRapport_idRapport_fkey"
    FOREIGN KEY ("idRapport") REFERENCES "rapportChat"("idRapport") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "docRapport_idRapport_idx"
  ON "docRapport"("idRapport");
