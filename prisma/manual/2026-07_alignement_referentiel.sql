-- =============================================================
-- Alignement final sur le référentiel équipe — écarts sans risque
-- =============================================================
-- La base est PARTAGÉE avec d'autres développeurs : chaque écart entre le
-- schéma du dépôt et le référentiel est une source de surprise pour eux. Ce
-- lot ferme tous ceux qui peuvent l'être sans casser la production.
--
-- ⚠️ TROIS RÉTRÉCISSEMENTS de colonnes. PostgreSQL refuse l'opération si une
-- seule valeur dépasse la nouvelle longueur, et le déploiement s'arrête là.
-- Relevé effectué sur la base le 30/07/2026 :
--
--   users.email    : maximum 49 caractères  → VARCHAR(100) passe
--   users.password : maximum 60 (bcrypt)    → VARCHAR(255) passe
--   pays.libelle   : maximum 19 sur 25 pays → VARCHAR(100) passe
--
-- Le contrôle est REJOUÉ à l'exécution plutôt que tenu pour acquis : des
-- comptes se créent entre-temps, et il vaut mieux une exception lisible qu'un
-- déploiement interrompu sans explication.
--
-- users.avatar_url passe en TEXT. Ce n'est pas cosmétique : la plus longue
-- valeur en base atteignait déjà 1955 caractères sur une limite de 2048.
--
-- Les SET DEFAULT ne modifient AUCUNE ligne existante — ils ne s'appliquent
-- qu'aux insertions futures qui omettent la colonne. Ils sont naturellement
-- rejouables.
--
-- Application : psql -h localhost -U alanyavox -d alanya -v ON_ERROR_STOP=1 \
--                    -f prisma/manual/2026-07_alignement_referentiel.sql

DO $$
DECLARE
  trop_longs INTEGER;
BEGIN
  ---------------------------------------------------------------
  -- 1. users.email : TEXT -> VARCHAR(100)
  ---------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'users' AND column_name = 'email'
               AND character_maximum_length IS DISTINCT FROM 100) THEN
    SELECT count(*) INTO trop_longs FROM "users" WHERE length("email") > 100;
    IF trop_longs > 0 THEN
      RAISE EXCEPTION 'users.email : % valeur(s) dépassent 100 caractères.', trop_longs;
    END IF;
    ALTER TABLE "users" ALTER COLUMN "email" TYPE VARCHAR(100);
  END IF;

  ---------------------------------------------------------------
  -- 2. users.password : TEXT -> VARCHAR(255)
  ---------------------------------------------------------------
  -- Un hash bcrypt fait 60 caractères. 255 laisse la place à un algorithme
  -- plus verbeux (argon2 en produit ~100) sans jamais gêner.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'users' AND column_name = 'password'
               AND character_maximum_length IS DISTINCT FROM 255) THEN
    SELECT count(*) INTO trop_longs FROM "users" WHERE length("password") > 255;
    IF trop_longs > 0 THEN
      RAISE EXCEPTION 'users.password : % hash(s) dépassent 255 caractères.', trop_longs;
    END IF;
    ALTER TABLE "users" ALTER COLUMN "password" TYPE VARCHAR(255);
  END IF;

  ---------------------------------------------------------------
  -- 3. pays.libelle : VARCHAR(200) -> VARCHAR(100)
  ---------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'pays' AND column_name = 'libelle'
               AND character_maximum_length IS DISTINCT FROM 100) THEN
    SELECT count(*) INTO trop_longs FROM "pays" WHERE length("libelle") > 100;
    IF trop_longs > 0 THEN
      RAISE EXCEPTION 'pays.libelle : % valeur(s) dépassent 100 caractères.', trop_longs;
    END IF;
    ALTER TABLE "pays" ALTER COLUMN "libelle" TYPE VARCHAR(100);
  END IF;
END $$;

---------------------------------------------------------------
-- 4. users.avatar_url : VARCHAR(2048) -> TEXT
---------------------------------------------------------------
-- Élargissement : PostgreSQL le fait sans réécrire la table.
ALTER TABLE "users" ALTER COLUMN "avatar_url" TYPE TEXT;

---------------------------------------------------------------
-- 5. Valeurs par défaut
---------------------------------------------------------------
-- Aucune ligne existante n'est touchée : un DEFAULT ne s'applique qu'aux
-- insertions futures qui omettent la colonne.
ALTER TABLE "users"   ALTER COLUMN "updatedAt"       SET DEFAULT now();

ALTER TABLE "pays"    ALTER COLUMN "prefix"          SET DEFAULT '';
ALTER TABLE "pays"    ALTER COLUMN "timeZone"        SET DEFAULT 'Africa/Dakar';
ALTER TABLE "pays"    ALTER COLUMN "decalageHoraire" SET DEFAULT 0;

ALTER TABLE "meeting" ALTER COLUMN "start_time"      SET DEFAULT now();
ALTER TABLE "meeting" ALTER COLUMN "duree"           SET DEFAULT 0;
ALTER TABLE "meeting" ALTER COLUMN "objet"           SET DEFAULT 'Réunion';
ALTER TABLE "meeting" ALTER COLUMN "room"            SET DEFAULT 'default-room';
ALTER TABLE "meeting" ALTER COLUMN "type_media"      SET DEFAULT 1;
