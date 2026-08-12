-- Musique d'attente d'un centre d'appels — table `center_music`.
--
-- ⚠️ CRÉÉE PAR LA COLLÈGUE, ELLE EXISTE DÉJÀ EN PRODUCTION (deux lignes au
-- 12/08/2026, pour `202020` et `0000`). Ce fichier ne la crée donc pas sur la
-- prod : tout y est sauté. Il existe pour qu'une base NEUVE la possède, et parce
-- que tout modèle déclaré dans `schema.prisma` doit avoir son SQL ici.
--
-- Jumelle exacte de `vocal` : mêmes colonnes citées en camelCase, même unicité
-- (entreprise, centre), mêmes clés étrangères en CASCADE. Forme relevée par
-- `\d center_music` sur la production, et non devinée.

CREATE TABLE IF NOT EXISTS "center_music" (
  "idMusic"         SERIAL       PRIMARY KEY,
  "idCompany"       INTEGER      NOT NULL,
  "center_alanyaID" UUID         NOT NULL,
  "url_music"       VARCHAR(255) NOT NULL
);

-- Les clés étrangères séparément : sur une base où la table préexiste, le
-- `CREATE TABLE` ci-dessus est sauté et ne les poserait jamais.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'center_music_idCompany_fkey'
  ) THEN
    ALTER TABLE "center_music"
      ADD CONSTRAINT "center_music_idCompany_fkey"
      FOREIGN KEY ("idCompany") REFERENCES "company" ("idcompany")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'center_music_center_alanyaID_fkey'
  ) THEN
    ALTER TABLE "center_music"
      ADD CONSTRAINT "center_music_center_alanyaID_fkey"
      FOREIGN KEY ("center_alanyaID") REFERENCES "users" ("alanyaID")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "center_music_company_center_key"
  ON "center_music" ("idCompany", "center_alanyaID");

CREATE INDEX IF NOT EXISTS "center_music_idCompany_idx"
  ON "center_music" ("idCompany");
