-- =============================================================
-- CONSOLE DE GESTION — le « socle » d'un compte (24/10/2026)
-- =============================================================
-- Le genre public d'un compte, comme chez Alanya2026 (`users.account_type`) :
-- 0 Personnel, 1 Business, 2 Officiel. Il se règle depuis la fiche du compte
-- dans la console (`PUT /api/admin/users/:id/socle`).
--
-- ⚠️ L'OFFICIEL RESTE AUSSI `type_compte = 5` : c'est lui que lisent les cinq
-- portes du refus de réponse (`src/lib/compte-officiel.mjs`) et alanyaCenter.
-- Les deux valeurs sont tenues ensemble par le serveur (création du compte
-- officiel, révocation) ; la mise à niveau ci-dessous aligne l'existant.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "account_type" SMALLINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_account_type_chk') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_account_type_chk" CHECK ("account_type" IN (0, 1, 2));
  END IF;
END $$;

UPDATE "users" SET "account_type" = 2 WHERE "type_compte" = 5 AND "account_type" <> 2;
