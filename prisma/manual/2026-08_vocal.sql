-- Invite vocale d'un centre d'appels — table `vocal`.
--
-- ⚠️ CETTE TABLE EXISTE DÉJÀ EN PRODUCTION, créée par la plateforme du collègue
-- (une ligne présente au 12/08/2026, centre « 0000 ass_client »). Ce fichier ne
-- la crée donc PAS sur la prod : tout y est sauté. Il existe pour qu'une base
-- NEUVE la possède, et pour que la forme exacte soit écrite quelque part dans le
-- dépôt — c'est très exactement le trou qui avait fait perdre `geo`, présente en
-- production mais déclarée nulle part, donc invisible de Prisma et absente de
-- toute base reconstruite.
--
-- Noms de colonnes en camelCase CITÉ (`"idVocal"`, `"idCompany"`,
-- `"center_alanyaID"`) : ce sont ceux de la table réelle, relevés par `\d vocal`
-- et non devinés. PostgreSQL replierait des identifiants non cités en
-- minuscules, et le modèle Prisma ne retrouverait plus ses colonnes.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : tout est donc
-- idempotent.

CREATE TABLE IF NOT EXISTS "vocal" (
  "idVocal"         SERIAL       PRIMARY KEY,
  "idCompany"       INTEGER      NOT NULL,
  "center_alanyaID" UUID         NOT NULL,
  "url_vocal"       VARCHAR(255) NOT NULL
);

-- Les clés étrangères séparément : sur une base où la table préexiste, le
-- `CREATE TABLE` ci-dessus est sauté et ne les poserait jamais.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vocal_idCompany_fkey'
  ) THEN
    ALTER TABLE "vocal"
      ADD CONSTRAINT "vocal_idCompany_fkey"
      FOREIGN KEY ("idCompany") REFERENCES "company" ("idcompany")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vocal_center_alanyaID_fkey'
  ) THEN
    ALTER TABLE "vocal"
      ADD CONSTRAINT "vocal_center_alanyaID_fkey"
      FOREIGN KEY ("center_alanyaID") REFERENCES "users" ("alanyaID")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

-- Une invite par entreprise ET par centre. L'unicité ne porte volontairement pas
-- sur le seul centre : c'est la forme de la table de production, et elle laisse
-- un même numéro porter une invite différente selon l'entreprise.
CREATE UNIQUE INDEX IF NOT EXISTS "vocal_company_center_key"
  ON "vocal" ("idCompany", "center_alanyaID");

CREATE INDEX IF NOT EXISTS "vocal_idCompany_idx"
  ON "vocal" ("idCompany");
