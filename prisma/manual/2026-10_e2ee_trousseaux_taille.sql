-- La copie personnelle d'un trousseau de groupe : plus de limite pratique au
-- nombre de clés (décision du user, 10/10/2026 : « je ne veux pas de limite de
-- clé pour le moment »). Cours, chapitre 38.
--
-- La borne d'origine (1 000 000 de caractères, `2026-10_e2ee_groupes.sql`)
-- arrêtait la copie vers 8 600 versions de clé. Elle passe à 20 000 000 :
-- environ 170 000 versions — des centaines d'années d'exclusions quotidiennes.
--
-- ⚠️ UNE BORNE RESTE, ET C'EST VOULU : sans elle, un client malveillant
-- pourrait remplir le disque du serveur avec une « copie » de plusieurs
-- gigaoctets par groupe. Elle ne vise que l'abus, plus l'usage.
--
-- ⚠️ REJOUABLE : `scripts/apply-manual-sql.sh` rejoue chaque fichier à chaque
-- déploiement. On retire la contrainte si elle existe, et on la repose. Même
-- NOM que l'originale : le `CREATE TABLE IF NOT EXISTS` d'origine, rejoué avant
-- ce fichier, ne la recrée pas (la table existe déjà).
--
-- Pas de transaction propre dans ce fichier : le script de rejeu gère l'enchaînement.

ALTER TABLE "e2ee_trousseaux" DROP CONSTRAINT IF EXISTS "e2ee_trousseaux_corps_borne";
ALTER TABLE "e2ee_trousseaux"
  ADD CONSTRAINT "e2ee_trousseaux_corps_borne" CHECK (char_length("corps") <= 20000000);
