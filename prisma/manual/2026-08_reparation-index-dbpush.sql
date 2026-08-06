-- ===========================================================================
-- Reparation : trois index supprimes par un `prisma db push` sur la PRODUCTION
--
-- Le 06/08/2026 a 13:20 puis 13:24 UTC, un `prisma db push` a ete lance contre
-- la base de production. Trace dans /var/log/postgresql :
--
--   13:20:06 alanyavox@alanya ERROR: cannot drop index users_mobile_key
--            because constraint users_mobile_key on table users requires it
--   13:24:44 alanyavox@alanya ERROR: (idem)
--
-- `db push` N'EST PAS ATOMIQUE : il applique ses etapes une par une. Avant
-- d'echouer sur `users_mobile_key`, il avait deja supprime les TROIS index
-- ci-dessous. Confirme par comparaison de la structure avec la sauvegarde de
-- 03:00, restauree dans une base jetable : ce sont les seuls ecarts non
-- explicables par nos propres migrations.
--
-- Aucune donnee perdue — 50 comptes, 1 379 messages, 1 337 appels, 67 pays,
-- 8 852 villes, 138 appareils, identiques a la sauvegarde. Aucun renommage de
-- contrainte, aucun SET NOT NULL : l'echec a stoppe le reste.
--
-- La contrainte UNIQUE sur `users.mobile` a survecu, et c'est elle qui a
-- arrete la casse. ⚠️ L'indication de PostgreSQL (« You can drop constraint
-- users_mobile_key instead ») explique justement comment lever ce garde-fou :
-- ne JAMAIS la suivre, elle laisserait passer les ~100 etapes suivantes.
--
-- La cause de fond est traitee dans le meme lot : ces trois index et le
-- `@unique` de `mobile` existaient en base sans etre declares dans
-- `schema.prisma`. Prisma les prenait donc pour des objets a supprimer.
--
-- Definitions reprises telles quelles de la sauvegarde de 03:00, pas
-- reconstituees de memoire.
--
-- Idempotent : rejoue a chaque deploiement par `scripts/apply-manual-sql.sh`.
-- ===========================================================================

BEGIN;

-- Recherche d'un compte par son pays, ecran d'inscription et statistiques.
CREATE INDEX IF NOT EXISTS "users_idPays_idx"
  ON "users" USING btree ("idPays");

-- Filtre des entreprises par type.
CREATE INDEX IF NOT EXISTS "company_idTypeCompany_idx"
  ON "company" USING btree ("idTypeCompany");

-- Balayage des messages ephemeres arrives a echeance. Le plus couteux des
-- trois a perdre : sans lui, chaque passe de nettoyage parcourt les 1 379
-- messages en entier, et ce nombre ne fera que croitre.
CREATE INDEX IF NOT EXISTS "message_expires_at_idx"
  ON "message" USING btree (expires_at);

COMMIT;
