-- =============================================================
-- CONSOLE DE GESTION — les rôles d'administration (24/10/2026)
-- =============================================================
-- Depuis le 24/10/2026, la console se gère comme celle d'Alanya2026 : un
-- compte Alanya promu « Admin » (1) ou « Super Admin » (2) s'y connecte avec
-- son e-mail ou son numéro Alanya, et son mot de passe. 0 = simple utilisateur.
--
-- ⚠️ UNE COLONNE À PART, PAS `type_compte` : chez Alanya2026 le rôle y vit,
-- mais chez nous `type_compte` dit ce qu'EST le compte (agent, centre
-- d'appels, compte officiel…) et alanyaCenter le lit. Y mettre un rôle
-- casserait les deux.
--
-- ⚠️ LA VALEUR EST CONTRAINTE EN BASE (CHECK) : la base est partagée, et seule
-- une contrainte vaut pour tous les écrivains.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role_admin" SMALLINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_admin_chk') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_role_admin_chk" CHECK ("role_admin" IN (0, 1, 2));
  END IF;
END $$;

-- Peu de lignes non nulles : l'index partiel ne coûte presque rien et sert la
-- liste « Admins » de la console.
CREATE INDEX IF NOT EXISTS "users_role_admin_idx" ON "users" ("role_admin") WHERE "role_admin" > 0;
