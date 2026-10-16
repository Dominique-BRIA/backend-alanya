-- =============================================================
-- CONSOLE DE GESTION — les tables de tous les domaines (16/10/2026)
-- =============================================================
-- La console d'alanyavox.com/gestion (superroot d'alanyaCenter) administre la
-- plateforme : journal d'audit, réglages, purges, historique des numéros,
-- bienvenue, signalements, vérification des comptes, stickers, trajets.
-- Les diffusions ont leur propre fichier (2026-10_gestion_diffusions.sql).
--
-- ⚠️ PAS DE CLÉ ÉTRANGÈRE VERS `users` : la base est partagée avec
-- alanyaCenter, qui peut effacer un compte par un chemin que nous ne
-- contrôlons pas (même règle que `message_mention`).
--
-- ⚠️ LES ÉTATS SONT CONTRAINTS EN BASE (CHECK) : les deux systèmes écrivent
-- ici, et seule une contrainte vaut pour les deux.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

-- ── Journal d'audit : chaque écriture d'un superroot ─────────────────────
CREATE TABLE IF NOT EXISTS "gestion_audit" (
  "id"           BIGSERIAL    PRIMARY KEY,
  -- `master` ou `root:<idRoot>`.
  "admin"        VARCHAR(64)  NOT NULL,
  "admin_nom"    VARCHAR(100),
  -- La permission de la route : `users.ban`, `broadcasts.send`…
  "action"       VARCHAR(60)  NOT NULL,
  "route"        VARCHAR(200) NOT NULL,
  "cible_type"   VARCHAR(40),
  "cible_id"     VARCHAR(80),
  "motif"        VARCHAR(500),
  "ip"           VARCHAR(64),
  "statut_http"  INTEGER      NOT NULL,
  "cree_le"      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "gestion_audit_recent" ON "gestion_audit" ("cree_le" DESC);
CREATE INDEX IF NOT EXISTS "gestion_audit_action" ON "gestion_audit" ("action", "cree_le" DESC);

-- ── Réglages de la console : une valeur JSON par clé ────────────────────
CREATE TABLE IF NOT EXISTS "gestion_reglage" (
  "cle"          VARCHAR(80)  PRIMARY KEY,
  "valeur"       JSONB        NOT NULL,
  "modifie_le"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "modifie_par"  VARCHAR(64)
);

-- ── Passages des purges ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "gestion_purge_passage" (
  "id"           BIGSERIAL    PRIMARY KEY,
  "nom"          VARCHAR(60)  NOT NULL,
  "lance_le"     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "declencheur"  VARCHAR(8)   NOT NULL,
  "par_admin"    VARCHAR(64),
  "ok"           BOOLEAN      NOT NULL,
  "resultat"     JSONB,
  "erreur"       TEXT,
  "duree_ms"     INTEGER,
  CONSTRAINT "gestion_purge_declencheur" CHECK ("declencheur" IN ('auto', 'manual'))
);
CREATE INDEX IF NOT EXISTS "gestion_purge_passage_nom" ON "gestion_purge_passage" ("nom", "lance_le" DESC);

-- ── Changements de numéro Alanya faits par la console ───────────────────
CREATE TABLE IF NOT EXISTS "gestion_numero_historique" (
  "id"           BIGSERIAL    PRIMARY KEY,
  "user_id"      UUID         NOT NULL,
  "ancien"       VARCHAR(20)  NOT NULL,
  "nouveau"      VARCHAR(20)  NOT NULL,
  "change_le"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "change_par"   VARCHAR(64)  NOT NULL
);
CREATE INDEX IF NOT EXISTS "gestion_numero_historique_user" ON "gestion_numero_historique" ("user_id", "change_le" DESC);

-- ── Bienvenue : versions du message, et qui l'a reçu ────────────────────
CREATE TABLE IF NOT EXISTS "gestion_bienvenue" (
  "id"           BIGSERIAL    PRIMARY KEY,
  "version"      INTEGER      NOT NULL,
  "etat"         VARCHAR(10)  NOT NULL,
  -- [{ ordre, type: "text", texte }]
  "blocs"        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  "publie_le"    TIMESTAMPTZ,
  "publie_par"   VARCHAR(64),
  "cree_le"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "gestion_bienvenue_etat" CHECK ("etat" IN ('brouillon', 'publie', 'archive'))
);
-- 🔴 UN SEUL BROUILLON ET UNE SEULE VERSION PUBLIÉE, garantis par la base.
CREATE UNIQUE INDEX IF NOT EXISTS "gestion_bienvenue_un_brouillon" ON "gestion_bienvenue" ("etat") WHERE "etat" IN ('brouillon', 'publie');

CREATE TABLE IF NOT EXISTS "gestion_bienvenue_envoi" (
  -- Clé = le compte : la bienvenue ne part qu'une fois, quelle que soit la version.
  "user_id"      UUID         PRIMARY KEY,
  "version"      INTEGER      NOT NULL,
  "statut"       VARCHAR(8)   NOT NULL,
  "motif"        VARCHAR(60),
  "envoye_le"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "gestion_bienvenue_envoi_statut" CHECK ("statut" IN ('envoye', 'refuse', 'echec'))
);

-- ── Signalements ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "gestion_signalement" (
  "id"           BIGSERIAL    PRIMARY KEY,
  "cible_type"   VARCHAR(8)   NOT NULL,
  "message_id"   UUID,
  "user_id"      UUID,
  "auteur_id"    UUID         NOT NULL,
  "motif"        VARCHAR(40)  NOT NULL,
  "note"         VARCHAR(1000),
  "etat"         VARCHAR(10)  NOT NULL DEFAULT 'open',
  -- Copie du message au moment du signalement : il survit à sa suppression.
  "extrait"      TEXT,
  "cree_le"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "gestion_signalement_cible" CHECK (
    ("cible_type" = 'message' AND "message_id" IS NOT NULL) OR
    ("cible_type" = 'user' AND "user_id" IS NOT NULL)),
  CONSTRAINT "gestion_signalement_etat" CHECK ("etat" IN ('open', 'reviewing', 'actioned', 'dismissed'))
);
CREATE INDEX IF NOT EXISTS "gestion_signalement_file" ON "gestion_signalement" ("etat", "cree_le" DESC);
-- Un même auteur ne signale pas deux fois la même cible tant qu'elle est ouverte.
CREATE UNIQUE INDEX IF NOT EXISTS "gestion_signalement_unique_ouvert"
  ON "gestion_signalement" ("auteur_id", "cible_type", COALESCE("message_id"::text, "user_id"::text))
  WHERE "etat" IN ('open', 'reviewing');

CREATE TABLE IF NOT EXISTS "gestion_signalement_action" (
  "id"             BIGSERIAL    PRIMARY KEY,
  "signalement_id" BIGINT       NOT NULL REFERENCES "gestion_signalement"("id") ON DELETE CASCADE,
  "action"         VARCHAR(30)  NOT NULL,
  "note"           VARCHAR(1000),
  "admin"          VARCHAR(64)  NOT NULL,
  "admin_nom"      VARCHAR(100),
  "cree_le"        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── Vérification des comptes (badge) ────────────────────────────────────
-- 0 non demandé, 1 en cours, 2 vérifié, 3 refusé, 4 révoqué, 5 expiré.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "verification_statut" SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "verifie_jusqua" TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS "gestion_verification" (
  "id"             BIGSERIAL    PRIMARY KEY,
  "user_id"        UUID         NOT NULL,
  -- Le nom que le compte revendique, et celui qu'il portait à l'approbation.
  "nom_revendique" VARCHAR(150) NOT NULL,
  "nom_approuve"   VARCHAR(150),
  "statut"         VARCHAR(20)  NOT NULL DEFAULT 'pending',
  "motif"          VARCHAR(500),
  "motif_revocation" VARCHAR(500),
  "decide_par"     VARCHAR(100),
  "cree_le"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "decide_le"      TIMESTAMPTZ,
  "revoque_le"     TIMESTAMPTZ,
  CONSTRAINT "gestion_verification_statut" CHECK ("statut" IN
    ('pending', 'document_requested', 'approved', 'refused', 'cancelled', 'revoked'))
);
CREATE INDEX IF NOT EXISTS "gestion_verification_file" ON "gestion_verification" ("statut", "cree_le");
-- Une seule demande ouverte par compte.
CREATE UNIQUE INDEX IF NOT EXISTS "gestion_verification_une_ouverte"
  ON "gestion_verification" ("user_id") WHERE "statut" IN ('pending', 'document_requested');

CREATE TABLE IF NOT EXISTS "gestion_verification_document" (
  "id"             BIGSERIAL    PRIMARY KEY,
  "verification_id" BIGINT      NOT NULL REFERENCES "gestion_verification"("id") ON DELETE CASCADE,
  -- 1 pièce d'identité, 4 selfie avec la pièce.
  "type_doc"       SMALLINT     NOT NULL,
  -- Le fichier vit dans media_files (seau privé), déposé par le compte lui-même.
  "media_id"       UUID         NOT NULL,
  "depose_le"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "vues"           INTEGER      NOT NULL DEFAULT 0
);

-- ── Stickers ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "sticker_pack" (
  "id"             BIGSERIAL    PRIMARY KEY,
  "code"           VARCHAR(60)  NOT NULL UNIQUE,
  "nom"            JSONB        NOT NULL,
  "description"    JSONB,
  "auteur"         VARCHAR(100),
  "couverture_id"  BIGINT,
  "premium"        BOOLEAN      NOT NULL DEFAULT false,
  -- 0 brouillon, 1 publié, 2 archivé.
  "statut"         SMALLINT     NOT NULL DEFAULT 0,
  "ordre"          INTEGER      NOT NULL DEFAULT 0,
  "version"        INTEGER      NOT NULL DEFAULT 1,
  "publie_le"      TIMESTAMPTZ,
  "cree_le"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "modifie_le"     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "sticker_pack_statut" CHECK ("statut" IN (0, 1, 2))
);

CREATE TABLE IF NOT EXISTS "sticker_asset" (
  "id"             BIGSERIAL    PRIMARY KEY,
  "url"            TEXT         NOT NULL,
  "mime"           VARCHAR(60)  NOT NULL,
  "octets"         INTEGER      NOT NULL,
  "empreinte"      VARCHAR(64)  NOT NULL UNIQUE,
  "anime"          BOOLEAN      NOT NULL DEFAULT false,
  -- 0 actif, 1 retiré.
  "statut"         SMALLINT     NOT NULL DEFAULT 0,
  "cree_le"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "sticker_asset_statut" CHECK ("statut" IN (0, 1))
);
-- Le seau où vit le fichier (`public`, ou NULL = privé), comme media_files.espace.
ALTER TABLE "sticker_asset" ADD COLUMN IF NOT EXISTS "espace" VARCHAR(10);

CREATE TABLE IF NOT EXISTS "sticker" (
  "id"             BIGSERIAL    PRIMARY KEY,
  "pack_id"        BIGINT       NOT NULL REFERENCES "sticker_pack"("id") ON DELETE CASCADE,
  "asset_id"       BIGINT       NOT NULL REFERENCES "sticker_asset"("id"),
  "position"       INTEGER      NOT NULL DEFAULT 0,
  "emoji"          VARCHAR(16)  NOT NULL DEFAULT '',
  "nom"            JSONB        NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "sticker_par_pack" ON "sticker" ("pack_id", "position");

CREATE TABLE IF NOT EXISTS "sticker_signalement" (
  "id"             BIGSERIAL    PRIMARY KEY,
  "asset_id"       BIGINT       NOT NULL REFERENCES "sticker_asset"("id") ON DELETE CASCADE,
  "auteur_id"      UUID         NOT NULL,
  "motif"          VARCHAR(40)  NOT NULL,
  "statut"         SMALLINT     NOT NULL DEFAULT 0,
  "cree_le"        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── Trajets de confiance ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "trajet" (
  "id"             BIGSERIAL    PRIMARY KEY,
  "user_id"        UUID         NOT NULL,
  "nature"         VARCHAR(5)   NOT NULL,
  "statut"         VARCHAR(10)  NOT NULL DEFAULT 'ouvert',
  "demarre_le"     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "echeance"       TIMESTAMPTZ,
  "prolongations"  INTEGER      NOT NULL DEFAULT 0,
  "confirme"       BOOLEAN      NOT NULL DEFAULT false,
  "alerte_le"      TIMESTAMPTZ,
  "alerte_resolue_le" TIMESTAMPTZ,
  "clos_le"        TIMESTAMPTZ,
  "raison_cloture" VARCHAR(30),
  "points_purges"  BOOLEAN      NOT NULL DEFAULT false,
  CONSTRAINT "trajet_nature" CHECK ("nature" IN ('taxi', 'walk', 'sos')),
  CONSTRAINT "trajet_statut" CHECK ("statut" IN ('ouvert', 'alerte', 'clos'))
);
CREATE INDEX IF NOT EXISTS "trajet_recents" ON "trajet" ("demarre_le" DESC);
-- Un seul trajet ouvert par compte.
CREATE UNIQUE INDEX IF NOT EXISTS "trajet_un_ouvert" ON "trajet" ("user_id") WHERE "statut" IN ('ouvert', 'alerte');

CREATE TABLE IF NOT EXISTS "trajet_point" (
  "id"             BIGSERIAL    PRIMARY KEY,
  "trajet_id"      BIGINT       NOT NULL REFERENCES "trajet"("id") ON DELETE CASCADE,
  "lat"            DOUBLE PRECISION NOT NULL,
  "lng"            DOUBLE PRECISION NOT NULL,
  "precision_m"    REAL,
  "releve_le"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "trajet_point_coordonnees" CHECK ("lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180)
);
CREATE INDEX IF NOT EXISTS "trajet_point_par_trajet" ON "trajet_point" ("trajet_id", "releve_le");
