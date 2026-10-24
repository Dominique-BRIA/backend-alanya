-- =============================================================
-- CONSOLE DE GESTION — diffusions riches (24/10/2026)
-- =============================================================
-- Comme chez Alanya2026 : une diffusion peut porter une image ou une vidéo,
-- être rédigée en français, anglais (et chinois), et partir en STATUT de 24 h
-- du compte officiel plutôt qu'en message (`kind` 1).
--
-- `contenu` reste le texte français (colonne d'origine) ; `traductions` porte
-- toutes les langues. Un statut de diffusion est créé une fois PAR LANGUE
-- rédigée (`statuts` : langue → id du statut) ; chaque destinataire touché
-- reçoit une ligne de `gestion_statut_destinataire` vers celui de sa langue —
-- c'est ce qui le rend visible dans SON fil, et seulement dans le sien.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

ALTER TABLE "diffusion" ADD COLUMN IF NOT EXISTS "kind"        SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE "diffusion" ADD COLUMN IF NOT EXISTS "type_media"  SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE "diffusion" ADD COLUMN IF NOT EXISTS "media_url"   TEXT;
ALTER TABLE "diffusion" ADD COLUMN IF NOT EXISTS "couleur"     VARCHAR(9);
ALTER TABLE "diffusion" ADD COLUMN IF NOT EXISTS "traductions" JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "diffusion" ADD COLUMN IF NOT EXISTS "statuts"     JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'diffusion_kind_chk') THEN
    ALTER TABLE "diffusion" ADD CONSTRAINT "diffusion_kind_chk" CHECK ("kind" IN (0, 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'diffusion_type_media_chk') THEN
    ALTER TABLE "diffusion" ADD CONSTRAINT "diffusion_type_media_chk" CHECK ("type_media" IN (0, 1, 2));
  END IF;
END $$;

-- Qui voit quel statut officiel (diffusion en statut).
CREATE TABLE IF NOT EXISTS "gestion_statut_destinataire" (
  "statut_id" UUID        NOT NULL REFERENCES "statut"("ID") ON DELETE CASCADE,
  "user_id"   UUID        NOT NULL,
  "cree_le"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("statut_id", "user_id")
);
CREATE INDEX IF NOT EXISTS "gestion_statut_destinataire_user_idx" ON "gestion_statut_destinataire" ("user_id");
