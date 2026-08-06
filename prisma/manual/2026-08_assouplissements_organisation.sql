-- =============================================================
-- Organisation : assouplissement des liens et des contraintes
-- =============================================================
-- Deuxième volet du référentiel équipe (schéma du 05/08/2026).
--
-- L'intention d'ensemble : retirer un agent, un client ou un bordereau ne doit
-- plus EFFACER l'historique qui s'y rattache. Les clés passent donc de CASCADE
-- à SET NULL, ce qui suppose que les colonnes portantes deviennent nullables.
--
-- ⚠️ CES TABLES SONT VIDES en production (vérifié avant écriture : rapportChat,
-- commentaire, bordereauAgent et transferer comptent zéro ligne). C'est ce qui
-- rend sûrs les deux changements qui, autrement, ne le seraient pas :
-- `rapportChat.subject` qui rétrécit de 200 à 150 et devient obligatoire, et
-- `commentaire.content` qui devient obligatoire. Sur des données existantes,
-- l'un aurait tronqué et l'autre échoué. À revérifier si ce fichier devait un
-- jour être rejoué sur une base alimentée.
--
-- Deux demandes du référentiel NON reprises, parce que destructives et sans
-- rapport avec un assouplissement : la suppression de `rapportChat.mobile` et
-- de `rapportChat.type`. Elles sont vides aujourd'hui, mais une colonne
-- supprimée ne se récupère pas — à trancher avec l'équipe.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : tout est
-- idempotent, les contraintes étant recréées seulement si leur forme diffère.

BEGIN;

-- ── 1. bordereauAgent : l'agent peut disparaître, pas le bordereau ───────
ALTER TABLE "bordereauAgent" ALTER COLUMN "idAgent" DROP NOT NULL;

ALTER TABLE "bordereauAgent" DROP CONSTRAINT IF EXISTS "bordereauAgent_idAgent_fkey";
ALTER TABLE "bordereauAgent" ADD CONSTRAINT "bordereauAgent_idAgent_fkey"
  FOREIGN KEY ("idAgent") REFERENCES "users" ("alanyaID") ON DELETE SET NULL;

-- Index ramené à la seule colonne d'agent. Le tri par date n'y servait à rien :
-- on cherche les bordereaux D'UN agent, on ne les parcourt pas par ordre
-- chronologique global.
DROP INDEX IF EXISTS "bordereauAgent_idAgent_idx";
CREATE INDEX IF NOT EXISTS "bordereauAgent_idAgent_idx" ON "bordereauAgent" ("idAgent");

-- ── 2. rapportChat : agent et client détachables ─────────────────────────
ALTER TABLE "rapportChat" ALTER COLUMN "idAgent" DROP NOT NULL;
ALTER TABLE "rapportChat" ALTER COLUMN "idCustomer" DROP NOT NULL;

ALTER TABLE "rapportChat" DROP CONSTRAINT IF EXISTS "rapportChat_idAgent_fkey";
ALTER TABLE "rapportChat" ADD CONSTRAINT "rapportChat_idAgent_fkey"
  FOREIGN KEY ("idAgent") REFERENCES "users" ("alanyaID") ON DELETE SET NULL;

ALTER TABLE "rapportChat" DROP CONSTRAINT IF EXISTS "rapportChat_idCustomer_fkey";
ALTER TABLE "rapportChat" ADD CONSTRAINT "rapportChat_idCustomer_fkey"
  FOREIGN KEY ("idCustomer") REFERENCES "customerChat" ("ID") ON DELETE SET NULL;

-- Un rapport sans objet n'est pas exploitable : le champ devient obligatoire.
-- 150 caractères au lieu de 200 — la table est vide, rien n'est tronqué.
ALTER TABLE "rapportChat" ALTER COLUMN "subject" TYPE VARCHAR(150);
ALTER TABLE "rapportChat" ALTER COLUMN "subject" SET NOT NULL;

-- « Traité » est un état, pas une information optionnelle : 0 par défaut.
UPDATE "rapportChat" SET "traiter" = 0 WHERE "traiter" IS NULL;
ALTER TABLE "rapportChat" ALTER COLUMN "traiter" SET DEFAULT 0;
ALTER TABLE "rapportChat" ALTER COLUMN "traiter" SET NOT NULL;

-- Le degré de rapport s'aligne sur le type entier de la table qu'il référence.
ALTER TABLE "rapportChat" ALTER COLUMN "idDegreRapport" TYPE INTEGER;

DROP INDEX IF EXISTS "rapportChat_idAgent_date_idx";
CREATE INDEX IF NOT EXISTS "rapportChat_idAgent_idx" ON "rapportChat" ("idAgent");

-- ── 3. commentaire : le bordereau peut partir, le commentaire reste ──────
ALTER TABLE "commentaire" DROP CONSTRAINT IF EXISTS "commentaire_idBordAgent_fkey";
ALTER TABLE "commentaire" ADD CONSTRAINT "commentaire_idBordAgent_fkey"
  FOREIGN KEY ("idBordAgent") REFERENCES "bordereauAgent" ("idbordAgent") ON DELETE SET NULL;

-- Un commentaire vide n'a pas de sens ; la table est vide, rien à reprendre.
ALTER TABLE "commentaire" ALTER COLUMN "content" SET NOT NULL;

-- ── 4. transferer : qui a transféré, et pourquoi ─────────────────────────
-- Le transfert ne retenait que les services, jamais la personne. On ajoute
-- l'agent — détachable, pour ne pas perdre l'historique avec lui — et le motif.
ALTER TABLE "transferer" ADD COLUMN IF NOT EXISTS "idAgent"     UUID;
ALTER TABLE "transferer" ADD COLUMN IF NOT EXISTS "commentaire" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transferer_idAgent_fkey') THEN
    ALTER TABLE "transferer" ADD CONSTRAINT "transferer_idAgent_fkey"
      FOREIGN KEY ("idAgent") REFERENCES "users" ("alanyaID") ON DELETE SET NULL;
  END IF;
END $$;

-- ── 5. Index redondants retirés ──────────────────────────────────────────
-- Chacun doublait la colonne de tête d'un index déjà présent, ou portait une
-- clé étrangère si peu sélective que PostgreSQL ne l'aurait pas choisie. Un
-- index inutile n'accélère aucune lecture et ralentit toutes les écritures.
DROP INDEX IF EXISTS "accesadmin_idadmin_idx";
DROP INDEX IF EXISTS "accesadmin_idroot_idx";
DROP INDEX IF EXISTS "center_center_alanyaid_idx";
DROP INDEX IF EXISTS "center_idcompany_idx";
DROP INDEX IF EXISTS "center_users_alanyaid_idx";
DROP INDEX IF EXISTS "centercom_idcompany_idx";

COMMIT;
