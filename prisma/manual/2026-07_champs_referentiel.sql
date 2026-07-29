-- =============================================================
-- Quatre colonnes du référentiel équipe restées de côté
-- =============================================================
-- Strictement additif. Aucune colonne existante n'est modifiée, rien n'est
-- renommé, rien n'est supprimé.
--
-- Les trois colonnes NOT NULL portent un défaut : depuis PostgreSQL 11 cela ne
-- réécrit pas la table, l'ajout est immédiat même sur `users` et `pays` qui
-- contiennent déjà des données.
--
-- À noter : ce lot s'accompagne d'un alignement des NOMS DE CHAMPS Prisma sur
-- le référentiel (`center_alanyaID`, `date_at`, `acces_at`, relations en
-- majuscule…). Ces renommages n'apparaissent pas ici et c'est normal : les
-- noms physiques étaient déjà les bons, seuls changent les noms exposés par le
-- client TypeScript. Aucune migration n'est requise pour eux.
--
-- Application : psql -h localhost -U alanyavox -d alanya -v ON_ERROR_STOP=1 \
--                    -f prisma/manual/2026-07_champs_referentiel.sql

-- Statut actif du compte, distinct de `exclus` : `actif` relève de
-- l'utilisateur, `exclus` d'une décision d'administration.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "actif" SMALLINT NOT NULL DEFAULT 1;

-- Numéro de mobile personnel, à ne pas confondre avec `alanyaPhone`, qui est
-- l'identifiant Alanya.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "mobile" VARCHAR(20);

-- Libellé anglais du pays, à côté de `libelle`.
ALTER TABLE "pays"
  ADD COLUMN IF NOT EXISTS "libelleAnglais" VARCHAR(100) NOT NULL DEFAULT '';

-- Acheminement de l'appel : « relay » (passé par Coturn) ou « p2p » (direct).
-- Complète `mode` et `ip`, déjà présentes. Nullable : l'information n'est
-- connue qu'une fois la connexion WebRTC établie, et les appels déjà
-- enregistrés ne l'ont pas.
ALTER TABLE "callHistory"
  ADD COLUMN IF NOT EXISTS "transmission" VARCHAR(10);
