-- Listes de contacts : un second son, et un ordre de priorité choisi.
--
-- 12/09/2026.
--
-- POURQUOI DEUX COLONNES D'UN COUP. Elles répondent à la même question — « quel
-- son pour qui ? » — et l'une sans l'autre laisse le produit à mi-chemin :
-- deux sons par liste sans ordre de priorité rend le conflit DEUX fois plus
-- fréquent, puisqu'il faut alors départager les messages en plus des appels.
--
-- ⚠️ CE FICHIER EST LE VRAI MÉCANISME DE MIGRATION DE CE DÉPÔT.
-- `prisma/migrations/` n'est JAMAIS rejoué : c'est `scripts/apply-manual-sql.sh`
-- qui balaie `prisma/manual/*.sql`, et lui seul. Cinq incidents sont nés d'une
-- migration posée du mauvais côté — la dernière, `limite_reunion`, est restée
-- inappliquée plusieurs jours alors qu'on la croyait livrée.
--
-- ⚠️ `IF NOT EXISTS` PARTOUT : ce script est rejoué à chaque déploiement.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Le son des messages
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `ringtone` reste la sonnerie d'APPEL, sous son nom d'origine. Le renommer
-- aurait cassé tous les APK installés pour un gain de clarté nul : c'est le
-- champ neuf qui porte le qualificatif.
--
-- Même largeur que `ringtone` (300) et même espace de noms : soit un nom de
-- fichier livré avec le client, soit une URL de média relative.
ALTER TABLE "contactList"
  ADD COLUMN IF NOT EXISTS "ringtone_message" VARCHAR(300);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. L'ordre de priorité
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 🔴 PAS DE `DEFAULT 0`, ET C'EST LE POINT DÉLICAT DE CETTE MIGRATION.
--
-- Un défaut à 0 déclarerait que TOUTES les listes existantes sont premières —
-- c'est-à-dire un conflit généralisé, alors qu'on veut dire « personne n'a
-- encore choisi ». `NULL` porte cette absence, et le client retombe dessus sur
-- l'ordre alphabétique, exactement comme avant cette colonne.
--
-- Conséquence assumée : le tri doit toujours traiter `NULL` explicitement.
-- `ORDER BY ordre` mettrait les non-ordonnées en tête sous PostgreSQL
-- (NULLS FIRST est le défaut en ASC), soit l'inverse de ce qu'on veut.
-- Le tri correct est `ORDER BY ordre ASC NULLS LAST, libelle ASC`.
ALTER TABLE "contactList"
  ADD COLUMN IF NOT EXISTS "ordre" INTEGER;

-- Aucune contrainte d'unicité sur (alanyaID, ordre), volontairement.
--
-- Réordonner quatre listes, c'est écrire quatre lignes. Une contrainte
-- d'unicité ferait échouer l'écriture dès la deuxième, le temps que les rangs
-- se croisent — il faudrait alors passer par des valeurs temporaires négatives,
-- une transaction différée, ou un tri en deux passes. Deux listes au même rang
-- se départagent par le nom : c'est un désordre visuel, pas une corruption.
CREATE INDEX IF NOT EXISTS "contactList_alanyaID_ordre_idx"
  ON "contactList" ("alanyaID", "ordre");

-- ─────────────────────────────────────────────────────────────────────────────
-- Contrôle (à lancer à la main après application)
-- ─────────────────────────────────────────────────────────────────────────────
--
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'contactList'
--      AND column_name IN ('ringtone', 'ringtone_message', 'ordre')
--    ORDER BY column_name;
--
-- ⚠️ INTERROGER `information_schema`, JAMAIS `to_regclass('public.contactList')` :
-- sans guillemets, PostgreSQL replie le nom en minuscules et répond que la table
-- n'existe pas. Ce faux négatif a déjà fait crier à la panne de production.
