-- =============================================================
-- CONSOLE DE GESTION — le statut de bienvenue (24/10/2026)
-- =============================================================
-- Comme chez Alanya2026 (`welcome_status_delivery`) : à la fin de son
-- inscription, chaque compte reçoit des statuts de 24 h publiés par le compte
-- officiel « Alanya Work » — un par élément réglé dans la console.
--
-- Cette table sert À LA FOIS de garde anti-doublon (un élément n'est livré
-- qu'une fois par compte) et de CLÉ DE VISIBILITÉ : le compte officiel n'est
-- le contact de personne, et seul le compte qui a reçu un statut le voit dans
-- son fil (`GET /api/statuses`).
--
-- ⚠️ PAS DE CLÉ ÉTRANGÈRE vers `users` (base partagée avec alanyaCenter) ;
-- vers `statut`, si : un statut purgé emporte sa ligne de livraison.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

CREATE TABLE IF NOT EXISTS "gestion_statut_bienvenue_livraison" (
  "user_id"    UUID         NOT NULL,
  "element_id" INTEGER      NOT NULL,
  "statut_id"  UUID         NOT NULL REFERENCES "statut"("ID") ON DELETE CASCADE,
  "livre_le"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "element_id")
);

CREATE INDEX IF NOT EXISTS "gestion_statut_bienvenue_livraison_statut_idx"
  ON "gestion_statut_bienvenue_livraison" ("statut_id");
