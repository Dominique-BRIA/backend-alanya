-- =============================================================
-- Facturation des entreprises + colonnes manquantes de `company`
-- =============================================================
-- Reprise du volet SANS RISQUE du référentiel équipe (schéma reçu le
-- 05/08/2026) : uniquement des créations et des élargissements, aucun
-- renommage, aucune suppression, aucune valeur d'enum retirée.
--
-- Ce que le référentiel demandait et qui n'est VOLONTAIREMENT pas repris :
--
--  • `company.idtypecompany` en minuscules. La colonne réelle est
--    `idTypeCompany`, en camelCase, parce qu'elle suit celle qu'elle
--    référence (`typeCompany.idTypeCompany`). PostgreSQL distingue la casse
--    dès que l'identifiant est cité : la mapper en minuscules ferait chercher
--    une colonne qui n'existe pas.
--
--  • Le retrait de `prixabonnement.description`. Supprimer une colonne
--    portant des données ne se rejoue pas.
--
-- ⚠️ `scripts/apply-manual-sql.sh` REJOUE ce fichier à chaque déploiement.
-- Tout y est donc idempotent, y compris la création des types énumérés, que
-- PostgreSQL ne sait pas créer conditionnellement.

BEGIN;

-- ── 1. Types énumérés ────────────────────────────────────────────────────
-- `CREATE TYPE` n'accepte pas `IF NOT EXISTS` : on intercepte l'erreur de
-- doublon, seule façon de rendre l'opération rejouable.
DO $$
BEGIN
  CREATE TYPE "FactureStatut" AS ENUM ('BROUILLON', 'ENVOYEE', 'PAYEE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "JustificatifStatut" AS ENUM ('EN_ATTENTE', 'VALIDE', 'REJETE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. Comptes techniques de facturation ─────────────────────────────────
-- Distincts de `adminroot` : ce sont les opérateurs de la facturation
-- (lecture, écriture, comptabilité), pas les administrateurs d'entreprise.
-- Sans `@@map` côté Prisma, la table garde sa casse — d'où les guillemets.
CREATE TABLE IF NOT EXISTS "Root" (
  "idRoot"   SERIAL PRIMARY KEY,
  "username" VARCHAR(50)  NOT NULL,
  "password" VARCHAR(255) NOT NULL,
  "type"     SMALLINT     NOT NULL DEFAULT 0,
  "actif"    SMALLINT     NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "Root_username_key" ON "Root" ("username");

-- ── 3. Factures ──────────────────────────────────────────────────────────
-- `companyLibelle` et les libellés de lignes sont des COPIES prises au moment
-- de l'émission : une facture doit rester lisible telle qu'elle a été émise,
-- même si l'entreprise est renommée ou un tarif modifié ensuite.
--
-- `idCompany` en RESTRICT et non en CASCADE : supprimer une entreprise ne
-- doit pas effacer son historique comptable.
CREATE TABLE IF NOT EXISTS "facture" (
  "idFacture"          SERIAL PRIMARY KEY,
  "numero"             VARCHAR(30)   NOT NULL,
  "idCompany"          INTEGER       NOT NULL,
  "companyLibelle"     VARCHAR(60)   NOT NULL,
  "idSuperAdmin"       INTEGER,
  "createdByRootId"    INTEGER,
  "annee"              INTEGER       NOT NULL,
  "periodeDebut"       DATE          NOT NULL,
  "periodeFin"         DATE          NOT NULL,
  "nombreAgents"       INTEGER       NOT NULL,
  "nombreCentresAppel" INTEGER       NOT NULL,
  "aNumeroCourt"       BOOLEAN       NOT NULL,
  "montantTotal"       DECIMAL(12,2) NOT NULL,
  "statut"             "FactureStatut" NOT NULL DEFAULT 'BROUILLON',
  "createdAt"          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "envoyeeAt"          TIMESTAMPTZ,
  "payeeAt"            TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS "facture_numero_key"     ON "facture" ("numero");
CREATE INDEX        IF NOT EXISTS "facture_company_annee_idx" ON "facture" ("idCompany", "annee");
CREATE INDEX        IF NOT EXISTS "facture_superadmin_idx"    ON "facture" ("idSuperAdmin");

-- ── 4. Lignes de facture ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "facture_ligne" (
  "idLigne"          SERIAL PRIMARY KEY,
  "idFacture"        INTEGER       NOT NULL,
  "idPrixAbonnement" INTEGER,
  "libelleSnapshot"  VARCHAR(100)  NOT NULL,
  "type"             SMALLINT      NOT NULL,
  "quantite"         INTEGER       NOT NULL,
  "prixUnitaire"     DECIMAL(10,2) NOT NULL,
  "montantLigne"     DECIMAL(12,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS "facture_ligne_facture_idx" ON "facture_ligne" ("idFacture");

-- ── 5. Justificatifs de paiement ─────────────────────────────────────────
-- Deux dépositaires possibles — un administrateur d'entreprise ou un compte
-- technique — d'où deux clés étrangères distinctes plutôt qu'une colonne
-- unique dont on ne saurait pas quelle table elle désigne.
CREATE TABLE IF NOT EXISTS "justificatif_paiement" (
  "idJustificatif"        SERIAL PRIMARY KEY,
  "idFacture"             INTEGER      NOT NULL,
  "fichierUrl"            VARCHAR(255) NOT NULL,
  "uploadedByAdminRootId" INTEGER,
  "uploadedByRootId"      INTEGER,
  "statut"                "JustificatifStatut" NOT NULL DEFAULT 'EN_ATTENTE',
  "raisonRejet"           TEXT,
  "validatedByRootId"     INTEGER,
  "validatedAt"           TIMESTAMPTZ,
  "createdAt"             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "justificatif_facture_idx" ON "justificatif_paiement" ("idFacture");

-- ── 6. Clés étrangères ───────────────────────────────────────────────────
-- Posées après coup, et non dans les `CREATE TABLE` : une contrainte nommée
-- ne se crée pas conditionnellement, il faut interroger le catalogue.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facture_company_fkey') THEN
    ALTER TABLE "facture" ADD CONSTRAINT "facture_company_fkey"
      FOREIGN KEY ("idCompany") REFERENCES "company" ("idcompany") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facture_superadmin_fkey') THEN
    ALTER TABLE "facture" ADD CONSTRAINT "facture_superadmin_fkey"
      FOREIGN KEY ("idSuperAdmin") REFERENCES "adminroot" ("idroot") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facture_createdby_fkey') THEN
    ALTER TABLE "facture" ADD CONSTRAINT "facture_createdby_fkey"
      FOREIGN KEY ("createdByRootId") REFERENCES "Root" ("idRoot") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facture_ligne_facture_fkey') THEN
    ALTER TABLE "facture_ligne" ADD CONSTRAINT "facture_ligne_facture_fkey"
      FOREIGN KEY ("idFacture") REFERENCES "facture" ("idFacture") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facture_ligne_prix_fkey') THEN
    ALTER TABLE "facture_ligne" ADD CONSTRAINT "facture_ligne_prix_fkey"
      FOREIGN KEY ("idPrixAbonnement") REFERENCES "prixabonnement" ("idabonnement") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'justificatif_facture_fkey') THEN
    ALTER TABLE "justificatif_paiement" ADD CONSTRAINT "justificatif_facture_fkey"
      FOREIGN KEY ("idFacture") REFERENCES "facture" ("idFacture") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'justificatif_adminroot_fkey') THEN
    ALTER TABLE "justificatif_paiement" ADD CONSTRAINT "justificatif_adminroot_fkey"
      FOREIGN KEY ("uploadedByAdminRootId") REFERENCES "adminroot" ("idroot") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'justificatif_uploadroot_fkey') THEN
    ALTER TABLE "justificatif_paiement" ADD CONSTRAINT "justificatif_uploadroot_fkey"
      FOREIGN KEY ("uploadedByRootId") REFERENCES "Root" ("idRoot") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'justificatif_validateur_fkey') THEN
    ALTER TABLE "justificatif_paiement" ADD CONSTRAINT "justificatif_validateur_fkey"
      FOREIGN KEY ("validatedByRootId") REFERENCES "Root" ("idRoot") ON DELETE SET NULL;
  END IF;
END $$;

-- ── 7. `company` : colonnes manquantes ───────────────────────────────────
-- `numero_court` et `isDelete` n'existent nulle part ; les trois `url_*`, si.
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "numero_court" VARCHAR(20);
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "isDelete"     BOOLEAN NOT NULL DEFAULT FALSE;

-- ⚠️ Les trois colonnes d'URL existent déjà, en VARCHAR(50). Le référentiel
-- les veut en 255, et `ADD COLUMN IF NOT EXISTS` aurait sauté la différence EN
-- SILENCE : le schéma aurait annoncé 255 pendant que la base en refusait plus
-- de 50, l'erreur ne se voyant qu'à l'insertion d'une URL un peu longue.
-- Un élargissement ne peut jamais échouer sur des données existantes.
ALTER TABLE "company" ALTER COLUMN "url_serveur" TYPE VARCHAR(255);
ALTER TABLE "company" ALTER COLUMN "url_media"   TYPE VARCHAR(255);
ALTER TABLE "company" ALTER COLUMN "url_doc"     TYPE VARCHAR(255);

-- ── 8. `prixabonnement` : distinguer ce qui est facturé ──────────────────
-- 0 = agent, 1 = centre d'appel, 2 = numéro court. Les lignes de facture en
-- gardent une copie, ce champ ne servant qu'à choisir le tarif applicable.
ALTER TABLE "prixabonnement" ADD COLUMN IF NOT EXISTS "type" SMALLINT NOT NULL DEFAULT 0;

COMMIT;
