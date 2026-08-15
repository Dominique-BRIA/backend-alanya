-- `calls.callerMaskId` — identité à montrer à l'APPELÉ pour un appel où
-- l'agent rappelle un client au nom du centre (« recontacter sous le nom du
-- centre », 15/08/2026). `initiatorId` reste le VRAI agent ; ce champ ne sert
-- qu'à la lecture (voir `serialiseAppelPour` et `handleCallRing`).
--
-- Nullable, sans donnée par défaut : NULL pour tout appel existant et pour
-- tout appel ordinaire à venir.

ALTER TABLE "calls"
  ADD COLUMN IF NOT EXISTS "callerMaskId" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calls_callerMaskId_fkey') THEN
    ALTER TABLE "calls"
      ADD CONSTRAINT "calls_callerMaskId_fkey"
      FOREIGN KEY ("callerMaskId") REFERENCES "users" ("alanyaID")
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "calls_callerMaskId_idx" ON "calls" ("callerMaskId");
