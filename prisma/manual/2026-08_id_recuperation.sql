-- =============================================================
-- Adresse facultative + identifiant de récupération
-- =============================================================
-- Demandé le 25/08/2026. L'adresse électronique ne sert qu'à REPRENDRE le
-- compte ; elle devient donc facultative à l'inscription, et qui n'en fournit
-- pas reçoit à la place un identifiant de récupération de 10 caractères.
--
-- Deux changements, tous deux élargissements — aucune donnée existante n'est
-- touchée, aucun compte ne perd son adresse :
--
--   1. users.email          NOT NULL      -> NULL autorisé
--   2. users.idRecuperation  (nouvelle)   VARCHAR(10) UNIQUE, nullable
--
-- ⚠️ L'UNICITÉ DE `email` EST CONSERVÉE, et elle reste correcte une fois la
-- colonne nullable : PostgreSQL traite deux NULL comme DISTINCTS dans un index
-- unique. Autant de comptes sans adresse peuvent donc coexister. Ne jamais
-- ajouter `NULLS NOT DISTINCT` à cet index — le deuxième compte sans adresse
-- serait refusé, et l'erreur ressemblerait à « cette adresse est déjà prise »
-- alors qu'aucune adresse n'a été saisie.
--
-- ⚠️ `idRecuperation` EST UNIQUE PARCE QU'IL SERT À RETROUVER LE COMPTE. Sans
-- la contrainte, deux comptes pourraient porter le même identifiant et la
-- réinitialisation en désignerait un au hasard — un compte pris pour un autre,
-- le pire des résultats pour une fonction de récupération.
--
-- 🔴 Ce n'est PAS un identifiant public : c'est un secret équivalent à un mot
-- de passe, montré une seule fois. Ne l'exposer dans aucune réponse d'API en
-- dehors de l'inscription qui vient de l'émettre.
--
-- Le nom de colonne est en camelCase, comme `alanyaID` et `alanyaPhone` du
-- référentiel équipe : les guillemets sont donc OBLIGATOIRES partout, sans quoi
-- PostgreSQL replie le nom en minuscules (piège déjà rencontré le 19/08/2026
-- avec `to_regclass`).
--
-- Application : psql -h localhost -U alanyavox -d alanya -v ON_ERROR_STOP=1 \
--                    -f prisma/manual/2026-08_id_recuperation.sql

DO $$
BEGIN
  -- 1. L'adresse devient facultative.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'email'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
  END IF;

  -- 2. L'identifiant de récupération.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'idRecuperation'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "idRecuperation" VARCHAR(10);
  END IF;
END $$;

-- Hors du bloc : `CREATE UNIQUE INDEX IF NOT EXISTS` porte déjà sa propre
-- idempotence, et le nom suit la convention Prisma (`users_<colonne>_key`) pour
-- que `prisma migrate diff` ne le voie pas comme un écart à combler.
CREATE UNIQUE INDEX IF NOT EXISTS "users_idRecuperation_key"
  ON "users" ("idRecuperation");
