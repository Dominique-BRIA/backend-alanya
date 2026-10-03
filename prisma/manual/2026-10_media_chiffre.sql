-- =============================================================
-- MÉDIAS CHIFFRÉS DE BOUT EN BOUT — la marque sur le fichier
-- =============================================================
-- Plan du 03/10/2026 (cours, chapitre 23). Un média envoyé dans une
-- conversation chiffrée part chiffré par l'appareil : le serveur et Backblaze
-- n'en stockent que des octets illisibles, la clé voyage dans l'enveloppe
-- Signal.
--
-- La colonne dit au serveur qu'il ne PEUT PAS lire ce fichier, pour qu'il ne
-- prétende pas le faire :
--   - l'export des médias l'écarte (il livrerait un fichier illisible) ;
--   - le transfert par le serveur le refuse (le destinataire n'aurait pas la
--     clé) — c'est l'appareil qui retransmet, avec la clé ;
--   - les clients savent qu'il faut le déchiffrer, et ne l'affichent jamais
--     tel quel.
--
-- Faux pour tout l'historique : rien ne change pour les médias existants.
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

ALTER TABLE "media_files"
  ADD COLUMN IF NOT EXISTS "chiffre" BOOLEAN NOT NULL DEFAULT false;
