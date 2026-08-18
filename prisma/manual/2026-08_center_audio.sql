-- Menu d'un CENTRE VOCAL : un audio par touche — table `center_audio`.
--
-- ⚠️ CETTE TABLE EXISTE DÉJÀ EN PRODUCTION depuis la plateforme du collègue
-- (4 lignes au 18/08/2026, centre `303030`). Ce fichier ne la crée donc pas :
-- il la DÉCRIT, pour qu'une base neuve reparte avec elle. Même trou que `geo`,
-- `vocal` et `center_music` avant lui — déclarés après coup pour la même raison.
--
-- Écrit d'après la structure RÉELLE relevée en production (types, longueurs,
-- noms d'index et de contraintes), et non d'après le modèle Prisma : c'est la
-- base qui fait foi ici, le schéma ne fait que la refléter. Contrôle appliqué :
-- `prisma migrate diff --from-url … --to-schema-datamodel` ne propose plus rien
-- sur cette table.
--
-- Différence avec `center` (le menu d'un centre d'APPELS) : une touche pointe
-- ici vers un SON à jouer, là vers un AGENT à faire sonner. Un centre vocal n'a
-- donc aucune ligne `center`, et réciproquement.

CREATE TABLE IF NOT EXISTS "center_audio" (
  "idcenteraudio"   SERIAL       PRIMARY KEY,
  "idCompany"       INTEGER      NOT NULL,
  "center_alanyaID" UUID         NOT NULL,
  -- SMALLINT et non INTEGER : c'est le type posé en production, et Prisma le
  -- déclare `@db.SmallInt`. Les trois doivent rester d'accord.
  "menunro"         SMALLINT     NOT NULL,
  "titre"           VARCHAR(150),
  "url_audio"       VARCHAR(255) NOT NULL,
  "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  -- Les bornes du pavé téléphonique, tenues par la BASE et non par le code.
  -- Une touche 12 n'existe sur aucun téléphone : la contrainte rend la donnée
  -- impossible à saisir plutôt que de compter sur chaque écriture pour y penser.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'center_audio_menunro_bornes'
  ) THEN
    ALTER TABLE "center_audio"
      ADD CONSTRAINT "center_audio_menunro_bornes"
      CHECK ("menunro" >= 0 AND "menunro" <= 9);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'center_audio_idCompany_fkey'
  ) THEN
    ALTER TABLE "center_audio"
      ADD CONSTRAINT "center_audio_idCompany_fkey"
      FOREIGN KEY ("idCompany") REFERENCES "company" ("idcompany")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'center_audio_center_alanyaID_fkey'
  ) THEN
    ALTER TABLE "center_audio"
      ADD CONSTRAINT "center_audio_center_alanyaID_fkey"
      FOREIGN KEY ("center_alanyaID") REFERENCES "users" ("alanyaID")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

-- ⚠️ UNIQUE, et c'est ce qui dispense d'écrire le moindre départage : une touche
-- porte au plus un son. `vocal`, dont l'unicité inclut l'entreprise, oblige au
-- contraire à choisir entre plusieurs lignes possibles pour un même numéro.
-- Posée en production comme INDEX unique et non comme contrainte : on reproduit
-- la forme exacte, sinon `migrate diff` signalerait un écart à chaque contrôle.
CREATE UNIQUE INDEX IF NOT EXISTS "center_audio_center_menunro_key"
  ON "center_audio" ("center_alanyaID", "menunro");

CREATE INDEX IF NOT EXISTS "center_audio_idCompany_idx"
  ON "center_audio" ("idCompany");
