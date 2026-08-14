-- Musiques d'attente d'un centre d'appels quand tous les agents sont occupés — table `vocal_attente`.
--
-- ⚠️ Créée par la collègue en production pour gérer la file d'attente d'un centre.
-- Contient une série de musiques classées par ordre d'écoute.
--
-- Jumelle de `center_music` et `vocal`, avec une colonne `ordre` pour la séquence d'écoute.

CREATE TABLE IF NOT EXISTS "vocal_attente" (
  "idAttente"       SERIAL       PRIMARY KEY,
  "idCompany"       INTEGER      NOT NULL,
  "center_alanyaID" UUID         NOT NULL,
  "url_music"       VARCHAR(255) NOT NULL,
  "ordre"           INTEGER      NOT NULL DEFAULT 1
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vocal_attente_idCompany_fkey'
  ) THEN
    ALTER TABLE "vocal_attente"
      ADD CONSTRAINT "vocal_attente_idCompany_fkey"
      FOREIGN KEY ("idCompany") REFERENCES "company" ("idcompany")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vocal_attente_center_alanyaID_fkey'
  ) THEN
    ALTER TABLE "vocal_attente"
      ADD CONSTRAINT "vocal_attente_center_alanyaID_fkey"
      FOREIGN KEY ("center_alanyaID") REFERENCES "users" ("alanyaID")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "vocal_attente_idCompany_idx"
  ON "vocal_attente" ("idCompany");

CREATE INDEX IF NOT EXISTS "vocal_attente_center_alanyaID_idx"
  ON "vocal_attente" ("center_alanyaID");
