-- =============================================================
-- Volet ORGANISATION & CENTRE D'APPELS — référentiel équipe
-- =============================================================
-- Treize tables nouvelles + une colonne ajoutée à « users ».
-- Strictement additif : aucune table existante n'est modifiée, à la seule
-- exception de « users.idcompany », colonne nullable qui rattache un compte à
-- une entreprise. Rien n'est renommé, rien n'est supprimé.
--
-- Les autres écarts du référentiel ont été VOLONTAIREMENT écartés parce qu'ils
-- casseraient la production : changement de type de la clé primaire de
-- « message » (UUID → BIGINT), disparition de « expires_at » (messages
-- éphémères) et de « deletedAt », perte de l'unicité sur « alanyaPhone ».
--
-- L'ordre de création suit les dépendances de clés étrangères. Ne pas le
-- réorganiser : « company » référence « ville », « pays », « abonnement » et
-- « adminroot », qui doivent donc exister avant elle.
--
-- Idempotent, rejouable, prévu pour scripts/apply-manual-sql.sh.
--
-- Application : psql -h localhost -U alanyavox -d alanya -v ON_ERROR_STOP=1 \
--                    -f prisma/manual/2026-07_organisation.sql

-- -------------------------------------------------------------
-- 1. ville  →  pays
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ville" (
  "idville" SERIAL PRIMARY KEY,
  "nom"     VARCHAR(45) NOT NULL,
  "idpays"  INTEGER,
  CONSTRAINT "ville_idpays_fkey"
    FOREIGN KEY ("idpays") REFERENCES "pays"("idPays") ON DELETE SET NULL ON UPDATE CASCADE
);

-- -------------------------------------------------------------
-- 2. adminroot  →  pays
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "adminroot" (
  "idroot"      SERIAL PRIMARY KEY,
  "nom"         VARCHAR(60)  NOT NULL,
  "email"       VARCHAR(100) NOT NULL UNIQUE,
  "alanyaphone" VARCHAR(15),
  "mobile"      VARCHAR(15),
  "username"    VARCHAR(30)  NOT NULL UNIQUE,
  "password"    VARCHAR(200) NOT NULL,
  "idpays"      INTEGER,
  "type"        INTEGER,
  "startprefix" INTEGER,
  "endprefix"   INTEGER,
  CONSTRAINT "adminroot_idpays_fkey"
    FOREIGN KEY ("idpays") REFERENCES "pays"("idPays") ON DELETE SET NULL ON UPDATE CASCADE
);

-- -------------------------------------------------------------
-- 3. prixabonnement  →  pays
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "prixabonnement" (
  "idabonnement" SERIAL PRIMARY KEY,
  "libelle"      VARCHAR(45)   NOT NULL,
  "montant"      NUMERIC(10,2) NOT NULL,
  "idpays"       INTEGER,
  CONSTRAINT "prixabonnement_idpays_fkey"
    FOREIGN KEY ("idpays") REFERENCES "pays"("idPays") ON DELETE SET NULL ON UPDATE CASCADE
);

-- -------------------------------------------------------------
-- 4. abonnement  →  adminroot
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "abonnement" (
  "idabonnement" SERIAL PRIMARY KEY,
  "prix"         NUMERIC(10,2) NOT NULL,
  "libelle"      VARCHAR(45)   NOT NULL,
  "rootid"       INTEGER,
  CONSTRAINT "abonnement_rootid_fkey"
    FOREIGN KEY ("rootid") REFERENCES "adminroot"("idroot") ON DELETE SET NULL ON UPDATE CASCADE
);

-- -------------------------------------------------------------
-- 5. company  →  ville, pays, abonnement, adminroot
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "company" (
  "idcompany"          SERIAL PRIMARY KEY,
  "libelle"            VARCHAR(60) NOT NULL,
  "description"        TEXT,
  "motcles"            VARCHAR(150),
  "adresse"            VARCHAR(150),
  "mobile"             VARCHAR(15),
  "email"              VARCHAR(60),
  "actif"              SMALLINT DEFAULT 1,
  "idville"            INTEGER,
  "idpays"             INTEGER,
  "idabonnement"       INTEGER,
  "rootid"             INTEGER,
  "prefixealanya"      INTEGER,
  "created_at"         DATE DEFAULT CURRENT_DATE,
  "lat"                DOUBLE PRECISION,
  "lon"                DOUBLE PRECISION,
  "maxagents"          INTEGER DEFAULT 20,
  "maxagentspercenter" INTEGER DEFAULT 5,
  CONSTRAINT "company_idville_fkey"
    FOREIGN KEY ("idville") REFERENCES "ville"("idville") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "company_idpays_fkey"
    FOREIGN KEY ("idpays") REFERENCES "pays"("idPays") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "company_idabonnement_fkey"
    FOREIGN KEY ("idabonnement") REFERENCES "abonnement"("idabonnement") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "company_rootid_fkey"
    FOREIGN KEY ("rootid") REFERENCES "adminroot"("idroot") ON DELETE SET NULL ON UPDATE CASCADE
);

-- -------------------------------------------------------------
-- 6. users.idcompany  →  company
-- -------------------------------------------------------------
-- Seule modification d'une table existante. Nullable et sans défaut : les
-- comptes actuels ne sont rattachés à aucune entreprise, et c'est exact.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "idcompany" INTEGER;

-- ADD CONSTRAINT ne connaît pas IF NOT EXISTS : on teste avant d'ajouter, sans
-- quoi rejouer le script échouerait.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_idcompany_fkey'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_idcompany_fkey"
      FOREIGN KEY ("idcompany") REFERENCES "company"("idcompany") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "users_idcompany_idx" ON "users"("idcompany");

-- -------------------------------------------------------------
-- 7. admin  →  adminroot, company
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "admin" (
  "idadmin"     SERIAL PRIMARY KEY,
  "nom"         VARCHAR(60)  NOT NULL,
  "email"       VARCHAR(100) NOT NULL UNIQUE,
  "alanyaphone" VARCHAR(15),
  "mobile"      VARCHAR(15),
  "username"    VARCHAR(30)  NOT NULL UNIQUE,
  "password"    VARCHAR(200) NOT NULL,
  "idroot"      INTEGER,
  "idcompany"   INTEGER,
  "type"        INTEGER,
  CONSTRAINT "admin_idroot_fkey"
    FOREIGN KEY ("idroot") REFERENCES "adminroot"("idroot") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "admin_idcompany_fkey"
    FOREIGN KEY ("idcompany") REFERENCES "company"("idcompany") ON DELETE SET NULL ON UPDATE CASCADE
);

-- -------------------------------------------------------------
-- 8. agence  →  ville, company
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "agence" (
  "idagence"    SERIAL PRIMARY KEY,
  "libelle"     VARCHAR(100) NOT NULL,
  "adresse"     VARCHAR(150),
  "mobile"      VARCHAR(15),
  "alanyaphone" VARCHAR(15),
  "idville"     INTEGER,
  "idcompany"   INTEGER,
  CONSTRAINT "agence_idville_fkey"
    FOREIGN KEY ("idville") REFERENCES "ville"("idville") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "agence_idcompany_fkey"
    FOREIGN KEY ("idcompany") REFERENCES "company"("idcompany") ON DELETE SET NULL ON UPDATE CASCADE
);

-- -------------------------------------------------------------
-- 9. service  →  company
-- -------------------------------------------------------------
-- « isDelete » et non « deleted » : état cible, aligné sur les six autres
-- tables. Le renommage sur une base déjà créée vit dans
-- 2026-07_service_isdelete.sql, qui passe APRÈS ce fichier dans l'ordre
-- alphabétique — ici on décrit ce qu'une base NEUVE doit avoir directement.
CREATE TABLE IF NOT EXISTS "service" (
  "idservice" SERIAL PRIMARY KEY,
  "libelle"   VARCHAR(100) NOT NULL,
  "isDelete"  BOOLEAN NOT NULL DEFAULT false,
  "idcompany" INTEGER,
  CONSTRAINT "service_idcompany_fkey"
    FOREIGN KEY ("idcompany") REFERENCES "company"("idcompany") ON DELETE SET NULL ON UPDATE CASCADE
);

-- -------------------------------------------------------------
-- 10. fonction  →  service, agence, users
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "fonction" (
  "idfonction" SERIAL PRIMARY KEY,
  "libelle"    VARCHAR(45) NOT NULL,
  "idservice"  INTEGER,
  "idagence"   INTEGER,
  "alanyaid"   UUID,
  CONSTRAINT "fonction_idservice_fkey"
    FOREIGN KEY ("idservice") REFERENCES "service"("idservice") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "fonction_idagence_fkey"
    FOREIGN KEY ("idagence") REFERENCES "agence"("idagence") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "fonction_alanyaid_fkey"
    FOREIGN KEY ("alanyaid") REFERENCES "users"("alanyaID") ON DELETE SET NULL ON UPDATE CASCADE
);

-- -------------------------------------------------------------
-- 11. gestioncompany  →  users, admin
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "gestioncompany" (
  "idgestion" SERIAL PRIMARY KEY,
  "alanyaid"  UUID,
  "action"    VARCHAR(100) NOT NULL,
  "date_at"   TIMESTAMP(6) DEFAULT now(),
  "ip"        VARCHAR(20),
  "idadmin"   INTEGER,
  CONSTRAINT "gestioncompany_alanyaid_fkey"
    FOREIGN KEY ("alanyaid") REFERENCES "users"("alanyaID") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "gestioncompany_idadmin_fkey"
    FOREIGN KEY ("idadmin") REFERENCES "admin"("idadmin") ON DELETE SET NULL ON UPDATE CASCADE
);

-- -------------------------------------------------------------
-- 12. centercom  →  company, adminroot
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "centercom" (
  "idcentercom" SERIAL PRIMARY KEY,
  "libelle"     VARCHAR(45) NOT NULL,
  "total"       INTEGER DEFAULT 0,
  "maxagents"   INTEGER DEFAULT 5,
  "idcompany"   INTEGER NOT NULL,
  "rootid"      INTEGER,
  CONSTRAINT "centercom_idcompany_fkey"
    FOREIGN KEY ("idcompany") REFERENCES "company"("idcompany") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "centercom_rootid_fkey"
    FOREIGN KEY ("rootid") REFERENCES "adminroot"("idroot") ON DELETE SET NULL ON UPDATE CASCADE
);

-- -------------------------------------------------------------
-- 13. center  →  users (deux fois), company
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "center" (
  "idcenter"        SERIAL PRIMARY KEY,
  "libelle"         VARCHAR(45) NOT NULL,
  "center_alanyaid" UUID,
  "users_alanyaid"  UUID,
  "idcompany"       INTEGER,
  "menunro"         INTEGER,
  "in_call"         BOOLEAN DEFAULT false,
  CONSTRAINT "center_center_alanyaid_fkey"
    FOREIGN KEY ("center_alanyaid") REFERENCES "users"("alanyaID") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "center_users_alanyaid_fkey"
    FOREIGN KEY ("users_alanyaid") REFERENCES "users"("alanyaID") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "center_idcompany_fkey"
    FOREIGN KEY ("idcompany") REFERENCES "company"("idcompany") ON DELETE CASCADE ON UPDATE CASCADE
);

-- -------------------------------------------------------------
-- 14. accesadmin  →  admin, adminroot
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "accesadmin" (
  "idaccesadmin" SERIAL PRIMARY KEY,
  "idadmin"      INTEGER,
  "idroot"       INTEGER,
  "acces_at"     TIMESTAMP(6) DEFAULT now(),
  "ipadress"     VARCHAR(30) NOT NULL,
  CONSTRAINT "accesadmin_idadmin_fkey"
    FOREIGN KEY ("idadmin") REFERENCES "admin"("idadmin") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "accesadmin_idroot_fkey"
    FOREIGN KEY ("idroot") REFERENCES "adminroot"("idroot") ON DELETE CASCADE ON UPDATE CASCADE
);

-- -------------------------------------------------------------
-- 15. Index sur les clés étrangères en CASCADE
-- -------------------------------------------------------------
-- PostgreSQL n'indexe PAS les clés étrangères. Ces index-ci ne sont pas du
-- confort : sans eux, la suppression d'un compte ou d'une entreprise imposerait
-- un parcours complet de chaque table enfant pour propager la cascade — et
-- DELETE /api/account supprime justement un utilisateur avec toutes ses
-- dépendances.
CREATE INDEX IF NOT EXISTS "center_center_alanyaid_idx" ON "center"("center_alanyaid");
CREATE INDEX IF NOT EXISTS "center_users_alanyaid_idx"  ON "center"("users_alanyaid");
CREATE INDEX IF NOT EXISTS "center_idcompany_idx"       ON "center"("idcompany");
CREATE INDEX IF NOT EXISTS "centercom_idcompany_idx"    ON "centercom"("idcompany");
CREATE INDEX IF NOT EXISTS "accesadmin_idadmin_idx"     ON "accesadmin"("idadmin");
CREATE INDEX IF NOT EXISTS "accesadmin_idroot_idx"      ON "accesadmin"("idroot");
CREATE INDEX IF NOT EXISTS "fonction_alanyaid_idx"      ON "fonction"("alanyaid");
CREATE INDEX IF NOT EXISTS "gestioncompany_alanyaid_idx" ON "gestioncompany"("alanyaid");
