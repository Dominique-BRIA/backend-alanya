-- ════════════════════════════════════════════════════════════════════════
--  CHIFFREMENT — l'archive et ses serrures
--  Créé le 23/09/2026. Lot 3 de `docs/PLAN-E2EE.md`.
-- ════════════════════════════════════════════════════════════════════════
--
-- 🔴 CE QUE CES DEUX TABLES PERMETTENT : retrouver son historique sur un
-- nouvel appareil. Et ce qu'elles NE font pas : restaurer l'identité Signal.
--
-- Restaurer la clé d'identité ne rendrait rien — le Double Ratchet dérive une
-- clé par message et la détruit après usage. On sauvegarde donc LES MESSAGES,
-- pas les clés. Le nouvel appareil publie une identité neuve, et les
-- correspondants voient « la clé a changé » : c'est vrai, et c'est sain.
--
-- ⚠️ LE SERVEUR NE PEUT OUVRIR NI L'UNE NI L'AUTRE. `cle_enveloppee` est
-- chiffrée par une clé dérivée d'un secret qu'il n'a pas ; `contenu` est
-- chiffré par la clé maîtresse que cette enveloppe protège.
--
-- ⚠️ CE QU'IL VOIT QUAND MÊME, et qu'il faut savoir : la taille des blocs, leur
-- date, et le nombre de messages annoncé. Des métadonnées — le chiffrement ne
-- les cache pas plus ici qu'ailleurs.
--
-- ── PROUVÉ PAR `prisma migrate diff` ────────────────────────────────────
--
-- Le corps de ce fichier est la sortie EXACTE de :
--
--   npx prisma migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel  prisma/schema.prisma --script
--
-- filtrée sur ces deux tables. Rien n'a été retapé à la main : une colonne
-- écrite de mémoire finit toujours par diverger du schéma, et la dérive ne se
-- voit qu'au premier `db push` qui propose de détruire quelque chose.

-- ⚠️ REJOUABLE, COMME TOUT CE DOSSIER. Ce fichier a fait ÉCHOUER un
-- déploiement le 26/09/2026 : ses `CREATE TABLE` étaient nus, et une seconde
-- exécution s'arrêtait sur « relation "e2ee_serrures" already exists ».
--
-- `apply-manual-sql.sh` rejoue TOUS les fichiers à chaque déploiement — c'est
-- le mécanisme, pas un accident. Une instruction non protégée bloque donc la
-- mise en production de tout ce qui vient après elle, y compris des correctifs
-- sans aucun rapport. C'est ce qui est arrivé : le passage à Backblaze est
-- resté à quai à cause de cette ligne.
BEGIN;

-- ── LES SERRURES ────────────────────────────────────────────────────────
--
-- ⚠️ `algo` ET `parametres` PLUTÔT QU'UN SIMPLE COMPTEUR D'ITÉRATIONS.
-- L'étirement compense le manque d'entropie d'un secret : un mot de passe
-- humain passe par Argon2id (mémoire-dur, résistant aux cartes graphiques),
-- une clé de 256 bits tirée au sort n'a rien à étirer. Les paramètres sont
-- rangés AVEC la serrure — sans eux, durcir les réglages un jour rendrait
-- illisibles toutes celles déjà créées.
--
-- ⚠️ `UNIQUE (alanyaID, type)` EST LA LIGNE QUI COMPTE. Reposer une serrure du
-- même type doit REMPLACER l'ancienne. Sans cette contrainte, changer de mot de
-- passe laisserait derrière lui une serrure ouvrable par l'ANCIEN — et le
-- changer n'aurait alors rien changé du tout.

CREATE TABLE IF NOT EXISTS "e2ee_serrures" (
    "id" UUID NOT NULL,
    "alanyaID" UUID NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "sel" VARCHAR(64) NOT NULL,
    "iv" VARCHAR(32) NOT NULL,
    "cle_enveloppee" VARCHAR(128) NOT NULL,
    "algo" VARCHAR(20) NOT NULL,
    "parametres" VARCHAR(200) NOT NULL,
    "create_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "e2ee_serrures_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "e2ee_serrures_compte_type_uniq" ON "e2ee_serrures"("alanyaID", "type");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'e2ee_serrures_alanyaID_fkey') THEN
        ALTER TABLE "e2ee_serrures"
          ADD CONSTRAINT "e2ee_serrures_alanyaID_fkey"
          FOREIGN KEY ("alanyaID") REFERENCES "users"("alanyaID")
          ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ── LES BLOCS D'ARCHIVE ─────────────────────────────────────────────────
--
-- ⚠️ DES BLOCS QUI S'AJOUTENT, PAS UN FICHIER QU'ON RÉÉCRIT. Réécrire l'archive
-- entière à chaque message coûterait sa taille à chaque envoi, et une coupure
-- au milieu la perdrait tout entière.
--
-- ⚠️ `ON DELETE CASCADE` sur le compte : supprimer un compte emporte son
-- archive. C'est la seule conduite honnête — l'utilisateur a demandé que tout
-- parte, et nous ne pourrions de toute façon rien en faire.

CREATE TABLE IF NOT EXISTS "e2ee_archive_blocs" (
    "id" UUID NOT NULL,
    "alanyaID" UUID NOT NULL,
    "iv" VARCHAR(32) NOT NULL,
    "contenu" TEXT NOT NULL,
    "nb_messages" INTEGER NOT NULL,
    "create_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "e2ee_archive_blocs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "e2ee_archive_compte_idx" ON "e2ee_archive_blocs"("alanyaID", "create_at");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'e2ee_archive_blocs_alanyaID_fkey') THEN
        ALTER TABLE "e2ee_archive_blocs"
          ADD CONSTRAINT "e2ee_archive_blocs_alanyaID_fkey"
          FOREIGN KEY ("alanyaID") REFERENCES "users"("alanyaID")
          ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

COMMIT;
