-- Confidentialité des statuts — qui a le droit de voir les miens.
--
-- 🔴 CE QUI MANQUAIT. Un statut était visible par TOUTE personne qui vous avait
-- dans ses contacts, sans aucun réglage possible. WhatsApp propose trois
-- audiences depuis toujours ; nous n'en proposions aucune.
--
-- ⚠️ AUCUNE COLONNE AJOUTÉE À `statut`. Cette table vient du référentiel de
-- l'équipe (elle s'appelait `statuses` avant l'harmonisation du 24/07) : une
-- information qui nous est propre se met dans une table à nous, sinon c'est un
-- écart de plus à défendre à chaque harmonisation.
--
-- DEUX TABLES : `statut_confidentialite` porte le MODE (un par compte),
-- `statut_audience` porte la LISTE que ce mode interprète.
--
-- LA MÊME LIGNE SE LIT DIFFÉREMMENT SELON LE MODE, et c'est volontaire :
--   MES_CONTACTS       → la liste est ignorée ;
--   MES_CONTACTS_SAUF  → la liste EXCLUT ;
--   PARTAGER_AVEC      → la liste INCLUT.
-- Deux tables séparées auraient obligé à recopier la liste à chaque changement
-- de mode. Ici, basculer de « sauf » à « partager avec » conserve les personnes
-- déjà désignées — ce que fait WhatsApp.
--
-- ABSENCE DE LIGNE = `MES_CONTACTS`. Aucune migration de données n'est donc
-- nécessaire : les 79 comptes existants gardent exactement le comportement
-- d'aujourd'hui, et la règle s'applique sans que personne ait à régler quoi que
-- ce soit.
--
-- ✅ CONFORMITÉ AU MODÈLE PRISMA VÉRIFIÉE par
-- `npx prisma migrate diff --from-empty --to-schema-datamodel` : mêmes
-- colonnes, mêmes types, mêmes noms d'index. Seuls les noms de clés étrangères
-- diffèrent (convention explicite ici contre `..._fkey` chez Prisma), ce qui
-- est attendu et sans effet.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

-- Le type enum d'abord : PostgreSQL n'a pas de `CREATE TYPE IF NOT EXISTS`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StatusAudienceMode') THEN
    CREATE TYPE "StatusAudienceMode" AS ENUM
      ('MES_CONTACTS', 'MES_CONTACTS_SAUF', 'PARTAGER_AVEC');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "statut_confidentialite" (
  "alanyaID"   UUID NOT NULL,
  "mode"       "StatusAudienceMode" NOT NULL DEFAULT 'MES_CONTACTS',
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "statut_confidentialite_pkey" PRIMARY KEY ("alanyaID")
);

CREATE TABLE IF NOT EXISTS "statut_audience" (
  "id"         UUID NOT NULL,
  "alanyaID"   UUID NOT NULL,
  "idAutre"    UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "statut_audience_pkey" PRIMARY KEY ("id")
);

-- L'unicité PORTE la règle « une personne ne figure qu'une fois dans ma
-- liste » : aucun code à écrire pour la tenir, aucun contournement possible.
CREATE UNIQUE INDEX IF NOT EXISTS "statut_audience_alanyaID_idAutre_key"
  ON "statut_audience" ("alanyaID", "idAutre");

-- La liste est toujours lue en entier pour un auteur donné (« qui ai-je
-- nommé ? »), d'où cet index sur le seul propriétaire.
CREATE INDEX IF NOT EXISTS "statut_audience_alanyaID_idx"
  ON "statut_audience" ("alanyaID");

-- Clés étrangères posées à part : `ADD CONSTRAINT` n'a pas de `IF NOT EXISTS`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'statut_confidentialite_alanyaID_fkey') THEN
    ALTER TABLE "statut_confidentialite"
      ADD CONSTRAINT "statut_confidentialite_alanyaID_fkey"
      FOREIGN KEY ("alanyaID") REFERENCES "users"("alanyaID") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'statut_audience_alanyaID_fkey') THEN
    ALTER TABLE "statut_audience"
      ADD CONSTRAINT "statut_audience_alanyaID_fkey"
      FOREIGN KEY ("alanyaID") REFERENCES "users"("alanyaID") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'statut_audience_idAutre_fkey') THEN
    ALTER TABLE "statut_audience"
      ADD CONSTRAINT "statut_audience_idAutre_fkey"
      FOREIGN KEY ("idAutre") REFERENCES "users"("alanyaID") ON DELETE CASCADE;
  END IF;
END
$$;
