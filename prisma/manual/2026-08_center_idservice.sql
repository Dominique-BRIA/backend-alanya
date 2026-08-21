-- `center.idservice` — lien entre une touche du menu IVR et le catalogue
-- formel des services (`service.idservice`).
--
-- ⚠️ Colonne AJOUTÉE ici, pas héritée de la plateforme du collègue (contrairement
-- à `nom_service`/`vocal`/`geo`) : `center` (routage par touche, libellé libre)
-- et `service` (catalogue formel par entreprise, 3 lignes en prod) sont deux
-- tables du référentiel équipe jamais reliées entre elles. Demandé le
-- 15/08/2026 pour que `QueueFile`/`QueueFileHistorique.idService` — déjà
-- câblés côté code depuis leur création — reflètent le service réel choisi
-- par l'appelant au lieu de rester NULL faute de source.
--
-- Une correspondance automatique par libellé a été écartée : sur les 6 lignes
-- `center` existantes, une seule correspond exactement à un `service.libelle`,
-- une autre seulement en ignorant la casse, les quatre restantes à rien.
-- Une colonne explicite, remplie à la main, ne ment jamais.
--
-- Nullable et sans donnée par défaut : les lignes existantes restent NULL tant
-- que personne ne les rattache explicitement à un service.

ALTER TABLE "center"
  ADD COLUMN IF NOT EXISTS "idservice" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'center_idservice_fkey') THEN
    ALTER TABLE "center"
      ADD CONSTRAINT "center_idservice_fkey"
      FOREIGN KEY ("idservice") REFERENCES "service" ("idservice")
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "center_idservice_idx" ON "center" ("idservice");
