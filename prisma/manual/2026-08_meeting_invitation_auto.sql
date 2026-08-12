-- `meeting.invitation_auto` — mode d'approbation automatique des invitations.
--
-- 🔴 PANNE DE PRODUCTION AU MOMENT OÙ CE FICHIER EST ÉCRIT. Le code qui lit
-- cette colonne était déjà déployé (commit `01fad8c`), alors que la colonne
-- n'existait pas en base. Prisma sélectionne TOUTES les colonnes déclarées d'un
-- modèle : chaque lecture de réunion échouait donc sur
--
--     The column `meeting.invitation_auto` does not exist
--
-- ⚠️ LA CAUSE EST STRUCTURELLE, PAS UN OUBLI ISOLÉ. Deux mécanismes de
-- migration coexistent dans ce dépôt et **un seul est joué** :
-- `scripts/apply-manual-sql.sh` rejoue `prisma/manual/*.sql`, tandis que
-- `prisma/migrations/` n'est jamais appliqué — la base a été bâtie en SQL
-- manuel, et `prisma migrate deploy` y est inutilisable (historique en échec,
-- P3009). Toute évolution de schéma écrite côté Prisma seul disparaît donc en
-- silence, et ne se manifeste qu'en production, à la première lecture.
--
-- Réflexe à garder : après chaque ajout de champ dans `schema.prisma`, écrire
-- le SQL correspondant ICI, dans le même lot.
--
-- Valeurs : 0 = l'organisateur tranche chaque demande, 1 = approbation
-- automatique. `NOT NULL DEFAULT 0` reprend exactement le `@default(0)` du
-- modèle — les 24 réunions existantes conservent le comportement d'avant.

ALTER TABLE meeting
    ADD COLUMN IF NOT EXISTS invitation_auto SMALLINT NOT NULL DEFAULT 0;
