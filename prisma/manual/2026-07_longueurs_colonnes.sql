-- =============================================================
-- Ajustement de deux longueurs de colonnes
-- =============================================================
-- users.pseudo      : VARCHAR(100) -> VARCHAR(50)
-- users.alanyaPhone : VARCHAR(8)   -> VARCHAR(20)
--
-- ⚠️ Le premier est un RÉTRÉCISSEMENT sur une table qui contient des données.
-- PostgreSQL refuse l'opération si une seule valeur dépasse la nouvelle
-- longueur, et le déploiement s'arrêterait là. Contrôle effectué avant
-- d'écrire ce fichier, le 30/07/2026 : 44 pseudos renseignés, longueur
-- maximale 17, aucun au-dessus de 50.
--
-- Le contrôle est REJOUÉ ici à l'exécution plutôt que tenu pour acquis : des
-- comptes se créent entre-temps, et un échec silencieux à cet endroit
-- bloquerait tout le reste de la migration.
--
-- Le second est un élargissement, sans risque ni réécriture.
-- Il ne change PAS la longueur des Alanya ID générés : src/lib/publicNumber.ts
-- produit toujours 8 chiffres et src/lib/validation.ts n'accepte que 6 ou 8.
-- La colonne devient simplement plus tolérante.
--
-- L'unicité de alanyaPhone est CONSERVÉE. Le référentiel équipe la retire ;
-- ne pas la suivre sur ce point est délibéré, deux comptes pourraient sinon
-- porter le même Alanya ID.
--
-- Application : psql -h localhost -U alanyavox -d alanya -v ON_ERROR_STOP=1 \
--                    -f prisma/manual/2026-07_longueurs_colonnes.sql

DO $$
DECLARE
  trop_longs INTEGER;
BEGIN
  -- 1. pseudo -> VARCHAR(50)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'pseudo'
      AND character_maximum_length IS DISTINCT FROM 50
  ) THEN
    SELECT count(*) INTO trop_longs FROM "users" WHERE length("pseudo") > 50;
    IF trop_longs > 0 THEN
      RAISE EXCEPTION
        'Rétrécissement de users.pseudo impossible : % pseudo(s) dépassent 50 caractères. Les raccourcir avant de rejouer.',
        trop_longs;
    END IF;
    ALTER TABLE "users" ALTER COLUMN "pseudo" TYPE VARCHAR(50);
  END IF;

  -- 2. alanyaPhone -> VARCHAR(20)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'alanyaPhone'
      AND character_maximum_length IS DISTINCT FROM 20
  ) THEN
    ALTER TABLE "users" ALTER COLUMN "alanyaPhone" TYPE VARCHAR(20);
  END IF;
END $$;
