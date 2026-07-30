-- =============================================================
-- service.deleted  ->  service.isDelete
-- =============================================================
-- `service` avait sa propre notion de suppression logique, sous un autre nom
-- (`deleted`) et un autre type (SMALLINT 0/1), pendant que six autres tables
-- utilisent `isDelete` en BOOLEAN. Deux façons de dire la même chose dans un
-- même schéma : celle qui reste est la plus répandue.
--
-- ORDRE D'EXÉCUTION. Ce fichier passe APRÈS 2026-07_organisation.sql dans
-- l'ordre alphabétique (o < s), et c'est nécessaire : c'est organisation.sql
-- qui crée la table. L'y placer aurait été sans effet sur une base neuve, où
-- la table n'existe pas encore au moment où le renommage s'exécuterait.
--
-- organisation.sql décrit désormais l'ÉTAT CIBLE : sur une base neuve, la
-- colonne naît déjà en `isDelete` et les gardes ci-dessous ne trouvent rien à
-- faire.
--
-- SÛRETÉ. `service` était vide au 30/07/2026, mais le contrôle est rejoué à
-- l'exécution : le passage en NOT NULL échouerait sur une valeur nulle, et
-- mieux vaut une exception lisible qu'un déploiement interrompu.
--
-- Application : psql -h localhost -U alanyavox -d alanya -v ON_ERROR_STOP=1 \
--                    -f prisma/manual/2026-07_service_isdelete.sql

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'service' AND column_name = 'deleted')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'service' AND column_name = 'isDelete') THEN

    ALTER TABLE "service" RENAME COLUMN "deleted" TO "isDelete";

    -- Le défaut doit tomber avant le changement de type : `0` n'est pas un
    -- BOOLEAN valide, PostgreSQL refuserait la conversion.
    ALTER TABLE "service" ALTER COLUMN "isDelete" DROP DEFAULT;
    ALTER TABLE "service" ALTER COLUMN "isDelete" TYPE BOOLEAN
      USING ("isDelete" <> 0);

    -- L'ancienne colonne était nullable ; la nouvelle ne l'est pas.
    UPDATE "service" SET "isDelete" = false WHERE "isDelete" IS NULL;

    ALTER TABLE "service" ALTER COLUMN "isDelete" SET DEFAULT false;
    ALTER TABLE "service" ALTER COLUMN "isDelete" SET NOT NULL;
  END IF;
END $$;
