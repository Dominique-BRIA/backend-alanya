-- `center.nom_service` — nom du service montré à l'appelant du standard.
--
-- ⚠️ LA COLONNE EXISTE DÉJÀ EN PRODUCTION (varchar(45), nullable), ajoutée par la
-- plateforme du collègue. Ce fichier ne la crée donc pas sur la prod : il est
-- sauté. Il existe pour qu'une base NEUVE la possède, et parce que tout champ
-- déclaré dans `schema.prisma` doit avoir son SQL ici — Prisma sélectionne
-- TOUTES les colonnes déclarées, et une seule absente fait échouer chaque
-- lecture de la table. C'est ce qui a mis la production à terre trois fois
-- (`pays.iso2`, `GET /api/conversations`, `meeting.invitation_auto`).
--
-- ⚠️ `ADD COLUMN IF NOT EXISTS` NE VÉRIFIE PAS LE TYPE : une colonne déjà
-- présente dans un autre type serait sautée avec un simple NOTICE, et le schéma
-- Prisma divergerait de la base sans que rien ne le signale. D'où le contrôle
-- explicite en dessous, qui parle au lieu de laisser passer.

ALTER TABLE "center"
  ADD COLUMN IF NOT EXISTS "nom_service" VARCHAR(45);

DO $$
DECLARE
  type_reel TEXT;
  taille    INTEGER;
BEGIN
  SELECT data_type, character_maximum_length
    INTO type_reel, taille
    FROM information_schema.columns
   WHERE table_name = 'center' AND column_name = 'nom_service';

  IF type_reel IS DISTINCT FROM 'character varying' OR taille IS DISTINCT FROM 45 THEN
    RAISE EXCEPTION
      'center.nom_service attendu en VARCHAR(45), trouvé % (%). Le modèle Prisma et la base divergent.',
      type_reel, taille;
  END IF;
END $$;
