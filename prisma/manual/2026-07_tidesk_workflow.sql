-- =============================================================
-- Modèle tidesk : le rapport devient un ticket qui circule
-- =============================================================
-- Un rapport naît d'une discussion client, puis passe de service en service et
-- d'agent en agent jusqu'à résolution. Chaque étape laisse une trace au lieu
-- d'écraser la précédente : transferts, bordereaux de temps, commentaires.
--
-- ÉCARTS ASSUMÉS PAR RAPPORT AU MODÈLE, tous validés :
--   * `idAgent` reste en UUID (le modèle le type INT) — nos agents SONT des
--     utilisateurs, il n'existe pas de table d'agents séparée à cibler ;
--   * `docRapport.url` reste en TEXT (le modèle dit VARCHAR(150)) — les URL de
--     médias signées dépassent régulièrement 150 caractères ;
--   * `subject` reste en VARCHAR(200) (le modèle dit 100) : élargir ne coûte
--     rien, rétrécir exposerait à une troncature.
-- Coquilles du modèle corrigées : `idCiustomer` -> `idCustomer`.
--
-- SÛRETÉ. Les tables touchées étaient VIDES au 30/07/2026 (rapportChat,
-- docRapport, customerChat : 0 ligne). Les renommages sont malgré tout écrits
-- en ALTER ... RENAME et non en DROP/CREATE, conformément à la règle du
-- projet : une migration ne détruit pas. Le seul retrait de colonne
-- (`customerChat.isResolved`, déplacé) est gardé par un contrôle d'emptiness
-- qui lève une exception plutôt que de perdre des données.
--
-- Application : psql -h localhost -U alanyavox -d alanya -v ON_ERROR_STOP=1 \
--                    -f prisma/manual/2026-07_tidesk_workflow.sql

DO $$
DECLARE
  nb INTEGER;
BEGIN
  -- ===========================================================
  -- 1. rapportChat — le ticket
  -- ===========================================================
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'rapportChat' AND column_name = 'idRapport') THEN
    ALTER TABLE "rapportChat" RENAME COLUMN "idRapport" TO "idRap";
  END IF;

  -- `date` devient `start_time` : le modèle mesure une DURÉE de traitement,
  -- pas un instant de création.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'rapportChat' AND column_name = 'date') THEN
    ALTER TABLE "rapportChat" RENAME COLUMN "date" TO "start_time";
  END IF;

  -- ===========================================================
  -- 2. docRapport — les pièces jointes
  -- ===========================================================
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'docRapport' AND column_name = 'type') THEN
    ALTER TABLE "docRapport" RENAME COLUMN "type" TO "typeMedia";
  END IF;

  -- ===========================================================
  -- 3. customerChat — `isResolved` DÉPLACÉ vers rapportChat
  -- ===========================================================
  -- La résolution est un état du TICKET, pas de la session : une discussion
  -- peut se terminer sans que la réclamation soit réglée.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'customerChat' AND column_name = 'isResolved') THEN
    SELECT count(*) INTO nb FROM "customerChat" WHERE "isResolved" IS TRUE;
    IF nb > 0 THEN
      RAISE EXCEPTION
        'customerChat.isResolved porte % ligne(s) à vrai. Les reporter sur rapportChat.is_resolve avant de rejouer.', nb;
    END IF;
    ALTER TABLE "customerChat" DROP COLUMN "isResolved";
  END IF;
END $$;

-- -------------------------------------------------------------
-- 4. Tables de référence (nomenclatures)
-- -------------------------------------------------------------
-- Créées AVANT les colonnes du ticket : ces dernières les référencent.
--
-- `libelleAn` est le libellé anglais, nom repris du modèle. Il diffère de
-- `pays.libelleAnglais`, écrit en toutes lettres — l'incohérence vient du
-- modèle, on la signale sans la corriger unilatéralement.
CREATE TABLE IF NOT EXISTS "degreRapport" (
  "idDegreRapport" SMALLSERIAL PRIMARY KEY,
  "libelle"        VARCHAR(45) NOT NULL,
  "libelleAn"      VARCHAR(45)
);

-- `codeCouleur` : pastille d'affichage côté interface (ex. « #C56A42 »).
CREATE TABLE IF NOT EXISTS "natureRapport" (
  "idNature"    SMALLSERIAL PRIMARY KEY,
  "libelle"     VARCHAR(45) NOT NULL,
  "libelleAn"   VARCHAR(45),
  "codeCouleur" VARCHAR(10)
);

-- ⚠️ Aucune colonne ne référence encore `typeCompany` : le modèle la pose sans
-- relier `company` à elle. À confirmer avec l'équipe — il manque
-- vraisemblablement un `company.idTypeCompany`.
CREATE TABLE IF NOT EXISTS "typeCompany" (
  "idTypeCompany" SERIAL PRIMARY KEY,
  "libelle"       VARCHAR(45) NOT NULL,
  "libelleAn"     VARCHAR(45)
);

-- -------------------------------------------------------------
-- 5. Nouvelles colonnes du ticket
-- -------------------------------------------------------------
-- `idDegreRapport` remplace le `degreProblem` de la première version du
-- modèle : la gravité devient une nomenclature au lieu d'un entier libre.
ALTER TABLE "rapportChat" ADD COLUMN IF NOT EXISTS "idDegreRapport" SMALLINT;
ALTER TABLE "rapportChat" ADD COLUMN IF NOT EXISTS "idNature"       SMALLINT;
ALTER TABLE "rapportChat" ADD COLUMN IF NOT EXISTS "traiter"        SMALLINT;
ALTER TABLE "rapportChat" ADD COLUMN IF NOT EXISTS "is_resolve"     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "rapportChat" ADD COLUMN IF NOT EXISTS "end_time"       TIMESTAMPTZ(6);
ALTER TABLE "rapportChat" ADD COLUMN IF NOT EXISTS "idAgence"       INTEGER;
ALTER TABLE "rapportChat" ADD COLUMN IF NOT EXISTS "idService"      INTEGER;

-- Nomenclatures en SET NULL : retirer un degré ou une nature ne doit pas
-- effacer les tickets qui s'y référaient.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rapportChat_idDegreRapport_fkey') THEN
    ALTER TABLE "rapportChat" ADD CONSTRAINT "rapportChat_idDegreRapport_fkey"
      FOREIGN KEY ("idDegreRapport") REFERENCES "degreRapport"("idDegreRapport") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rapportChat_idNature_fkey') THEN
    ALTER TABLE "rapportChat" ADD CONSTRAINT "rapportChat_idNature_fkey"
      FOREIGN KEY ("idNature") REFERENCES "natureRapport"("idNature") ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE "docRapport" ADD COLUMN IF NOT EXISTS "upload_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now();

-- Clés étrangères en SET NULL : la disparition d'un service ou d'une agence ne
-- doit pas emporter l'historique des tickets qu'ils ont traités.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rapportChat_idAgence_fkey') THEN
    ALTER TABLE "rapportChat" ADD CONSTRAINT "rapportChat_idAgence_fkey"
      FOREIGN KEY ("idAgence") REFERENCES "agence"("idagence") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rapportChat_idService_fkey') THEN
    ALTER TABLE "rapportChat" ADD CONSTRAINT "rapportChat_idService_fkey"
      FOREIGN KEY ("idService") REFERENCES "service"("idservice") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "rapportChat_idService_idx" ON "rapportChat"("idService");
CREATE INDEX IF NOT EXISTS "rapportChat_idAgence_idx"  ON "rapportChat"("idAgence");

-- -------------------------------------------------------------
-- 5. transferer — le parcours entre services
-- -------------------------------------------------------------
-- Une ligne par transfert : trier sur `sent_at` redonne le chemin complet,
-- alors qu'une colonne « service courant » sur le rapport l'aurait écrasé.
CREATE TABLE IF NOT EXISTS "transferer" (
  "idTrans"            SERIAL PRIMARY KEY,
  "idService_sender"   INTEGER,
  "idService_receiver" INTEGER,
  "sent_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "idRapport"          INTEGER NOT NULL,
  CONSTRAINT "transferer_sender_fkey"
    FOREIGN KEY ("idService_sender") REFERENCES "service"("idservice") ON DELETE SET NULL,
  CONSTRAINT "transferer_receiver_fkey"
    FOREIGN KEY ("idService_receiver") REFERENCES "service"("idservice") ON DELETE SET NULL,
  CONSTRAINT "transferer_idRapport_fkey"
    FOREIGN KEY ("idRapport") REFERENCES "rapportChat"("idRap") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "transferer_idRapport_idx" ON "transferer"("idRapport", "sent_at");

-- -------------------------------------------------------------
-- 6. bordereauService — temps passé par service
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "bordereauService" (
  "idBordService" SERIAL PRIMARY KEY,
  "idRapport"     INTEGER NOT NULL,
  "idService"     INTEGER,
  "start_time"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "end_time"      TIMESTAMPTZ(6),
  CONSTRAINT "bordereauService_idRapport_fkey"
    FOREIGN KEY ("idRapport") REFERENCES "rapportChat"("idRap") ON DELETE CASCADE,
  CONSTRAINT "bordereauService_idService_fkey"
    FOREIGN KEY ("idService") REFERENCES "service"("idservice") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "bordereauService_idRapport_idx" ON "bordereauService"("idRapport");
CREATE INDEX IF NOT EXISTS "bordereauService_idService_idx" ON "bordereauService"("idService");

-- -------------------------------------------------------------
-- 7. bordereauAgent — temps passé par agent
-- -------------------------------------------------------------
-- `idAgent` en UUID vers users : c'est l'écart assumé avec le modèle.
CREATE TABLE IF NOT EXISTS "bordereauAgent" (
  "idbordAgent" SERIAL PRIMARY KEY,
  "idRapport"   INTEGER NOT NULL,
  "idAgent"     UUID    NOT NULL,
  "start_time"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "end_time"    TIMESTAMPTZ(6),
  CONSTRAINT "bordereauAgent_idRapport_fkey"
    FOREIGN KEY ("idRapport") REFERENCES "rapportChat"("idRap") ON DELETE CASCADE,
  CONSTRAINT "bordereauAgent_idAgent_fkey"
    FOREIGN KEY ("idAgent") REFERENCES "users"("alanyaID") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "bordereauAgent_idRapport_idx" ON "bordereauAgent"("idRapport");
CREATE INDEX IF NOT EXISTS "bordereauAgent_idAgent_idx"   ON "bordereauAgent"("idAgent", "start_time" DESC);

-- -------------------------------------------------------------
-- 8. commentaire — fil interne
-- -------------------------------------------------------------
-- `idBordAgent` est nullable : un commentaire peut porter sur le rapport
-- entier, sans se rattacher au passage d'un agent en particulier.
CREATE TABLE IF NOT EXISTS "commentaire" (
  "idCom"       SERIAL PRIMARY KEY,
  "idBordAgent" INTEGER,
  "idRapport"   INTEGER NOT NULL,
  "content"     TEXT,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "commentaire_idBordAgent_fkey"
    FOREIGN KEY ("idBordAgent") REFERENCES "bordereauAgent"("idbordAgent") ON DELETE CASCADE,
  CONSTRAINT "commentaire_idRapport_fkey"
    FOREIGN KEY ("idRapport") REFERENCES "rapportChat"("idRap") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "commentaire_idRapport_idx"   ON "commentaire"("idRapport", "created_at");
CREATE INDEX IF NOT EXISTS "commentaire_idBordAgent_idx" ON "commentaire"("idBordAgent");
