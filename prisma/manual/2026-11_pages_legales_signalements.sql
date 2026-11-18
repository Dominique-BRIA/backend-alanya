-- PUBLICATION SUR LE PLAY STORE (18/11/2026).
--
-- ① Les pages légales — politique de confidentialité et conditions
--    d'utilisation — vivent en base : elles se modifient depuis la console de
--    gestion, sans redéployer. Une première version est semée ici ; la console
--    l'écrase ensuite. Chaque enregistrement fait monter `version`.
--
-- ② Les signalements couvrent aussi un GROUPE et une réponse de l'ASSISTANT
--    (exigence Google pour les messageries et l'IA générative). Leur cible est
--    rangée dans `cible_id` : l'identifiant du groupe, ou celui du message de
--    l'assistant.
--
-- Rejouable sans effet.

CREATE TABLE IF NOT EXISTS "pages_legales" (
    "slug" VARCHAR(40) PRIMARY KEY,
    "titre" VARCHAR(200) NOT NULL,
    "contenu" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "maj_le" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "maj_par" VARCHAR(100)
);

ALTER TABLE "gestion_signalement" ADD COLUMN IF NOT EXISTS "cible_id" UUID;
ALTER TABLE "gestion_signalement" ALTER COLUMN "cible_type" TYPE VARCHAR(10);
ALTER TABLE "gestion_signalement" DROP CONSTRAINT IF EXISTS "gestion_signalement_cible";
ALTER TABLE "gestion_signalement" ADD CONSTRAINT "gestion_signalement_cible" CHECK (
    ("cible_type" = 'message' AND "message_id" IS NOT NULL) OR
    ("cible_type" = 'user' AND "user_id" IS NOT NULL) OR
    ("cible_type" IN ('group', 'ia') AND "cible_id" IS NOT NULL));

DROP INDEX IF EXISTS "gestion_signalement_unique_ouvert";
CREATE UNIQUE INDEX IF NOT EXISTS "gestion_signalement_unique_ouvert"
  ON "gestion_signalement" ("auteur_id", "cible_type",
     COALESCE("message_id"::text, "cible_id"::text, "user_id"::text))
  WHERE "etat" IN ('open', 'reviewing');
