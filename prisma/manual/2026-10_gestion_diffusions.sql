-- =============================================================
-- DIFFUSIONS DU COMPTE OFFICIEL (console de gestion, lot 1b)
-- =============================================================
-- Demandé le 15/10/2026 : depuis alanyavox.com/gestion, le superroot écrit à
-- une population choisie par critères (pays, entreprise, type de compte,
-- dates), tout de suite ou à une date fixée. Chaque destinataire reçoit un
-- message ordinaire du compte officiel « Alanya Work » (type_compte 5) dans
-- son tête-à-tête avec lui.
--
-- DEUX OBJETS.
--
--   `diffusion` : la demande — texte, critères, échéance, et l'état de son
--   traitement. `verrou_jusqua` dit quel tour de la boucle de fond la tient :
--   un processus redémarré au milieu d'un envoi la laisse expirer, et le tour
--   suivant REPREND là où l'autre s'était arrêté.
--
--   `diffusion_envoi` : une ligne par destinataire. 🔴 C'EST ELLE QUI REND LA
--   REPRISE SÛRE : la clé (diffusion, destinataire) empêche d'écrire deux fois
--   au même compte, même si deux tours se chevauchaient. Elle sert aussi
--   d'audit — qui a reçu quoi, et pourquoi un envoi a été refusé.
--
-- ⚠️ PAS DE CLÉ ÉTRANGÈRE VERS `users`, comme `message_mention` : la base est
-- partagée avec un second système, qui peut effacer un compte par un chemin
-- que nous ne contrôlons pas.
--
-- ⚠️ LES ÉTATS SONT CONTRAINTS EN BASE (CHECK), pas seulement dans le code :
-- les deux systèmes écrivent ici, et seule une contrainte vaut pour les deux.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

CREATE TABLE IF NOT EXISTS "diffusion" (
  "id"             BIGSERIAL    PRIMARY KEY,
  -- Tiré par la console : un double clic, ou un rejeu réseau, ne crée pas
  -- deux diffusions.
  "client_id"      VARCHAR(64)  NOT NULL UNIQUE,
  "expediteur_id"  UUID         NOT NULL,
  -- `master` ou `root:<idRoot>` : qui l'a lancée, pour l'audit.
  "cree_par"       VARCHAR(64)  NOT NULL,
  "contenu"        TEXT         NOT NULL,
  "criteres"       JSONB        NOT NULL,
  -- Le nombre annoncé à l'écran au moment de la confirmation.
  "estimation"     INTEGER      NOT NULL DEFAULT 0,
  "statut"         VARCHAR(16)  NOT NULL DEFAULT 'planifiee',
  "planifiee_a"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "total"          INTEGER      NOT NULL DEFAULT 0,
  "envoyes"        INTEGER      NOT NULL DEFAULT 0,
  "refuses"        INTEGER      NOT NULL DEFAULT 0,
  "echecs"         INTEGER      NOT NULL DEFAULT 0,
  "verrou_jusqua"  TIMESTAMPTZ,
  "cree_le"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "commencee_le"   TIMESTAMPTZ,
  "terminee_le"    TIMESTAMPTZ,
  CONSTRAINT "diffusion_statut_valide"
    CHECK ("statut" IN ('planifiee', 'en_cours', 'terminee', 'annulee', 'echec')),
  CONSTRAINT "diffusion_contenu_non_vide" CHECK (length(btrim("contenu")) > 0)
);

-- La boucle de fond ne regarde que ce qui reste à faire.
CREATE INDEX IF NOT EXISTS "diffusion_a_traiter"
  ON "diffusion" ("planifiee_a")
  WHERE "statut" IN ('planifiee', 'en_cours');
CREATE INDEX IF NOT EXISTS "diffusion_recentes" ON "diffusion" ("cree_le" DESC);

CREATE TABLE IF NOT EXISTS "diffusion_envoi" (
  "diffusion_id"  BIGINT       NOT NULL REFERENCES "diffusion"("id") ON DELETE CASCADE,
  "user_id"       UUID         NOT NULL,
  "conv_id"       UUID,
  "message_id"    UUID,
  "statut"        VARCHAR(8)   NOT NULL,
  -- Le motif d'un refus (BLOQUE…) ou d'un échec : de quoi expliquer un écart
  -- entre l'estimation et les envois.
  "motif"         VARCHAR(60),
  "envoye_le"     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY ("diffusion_id", "user_id"),
  CONSTRAINT "diffusion_envoi_statut_valide" CHECK ("statut" IN ('envoye', 'refuse', 'echec'))
);
