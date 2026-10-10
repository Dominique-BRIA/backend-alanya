-- LES ENVOIS EN MORCEAUX (10/10/2026).
--
-- Demande du user : « envoyer les fichiers en morceaux pour aller plus vite,
-- même quand l'application est fermée ou en arrière-plan ». Décision du
-- 10/10 : les morceaux passent PAR LE VPS (pas directement chez R2), ce qui
-- permet des morceaux petits (1 Mio) — une coupure ne coûte qu'un morceau.
--
-- Une ligne par envoi réservé. Le fichier se reconstitue sur le disque du
-- VPS (`storage/envois/<id>.bin`), chaque morceau écrit à sa place ; quand le
-- dernier arrive, le serveur l'assemble en un média ordinaire (`media_files`)
-- et la ligne passe à « termine ».
--
-- `envoi_morceaux_recus` dit quels morceaux sont arrivés : sa clé primaire
-- rend la réception IDEMPOTENTE (un morceau renvoyé ne compte pas deux fois),
-- et c'est elle qu'un appareil relit pour savoir quoi renvoyer après une
-- coupure ou un redémarrage.
--
-- ⚠️ REJOUABLE (IF NOT EXISTS) ; pas de transaction propre dans ce fichier.

CREATE TABLE IF NOT EXISTS "envoi_morceaux" (
  "id"             UUID         NOT NULL,
  "alanyaID"       UUID         NOT NULL
    REFERENCES "users"("alanyaID") ON DELETE CASCADE,
  -- Empreinte SHA-256 (hex) du jeton d'envoi. Le jeton lui-même n'est
  -- jamais gardé : il ne sert qu'à envoyer les morceaux de CET envoi, et dure
  -- autant que lui — un jeton d'accès (15 min) expirerait pendant qu'Android
  -- envoie, application fermée.
  "jeton_hash"     CHAR(64)     NOT NULL,
  "taille"         INTEGER      NOT NULL,
  "taille_morceau" INTEGER      NOT NULL,
  "nb_morceaux"    INTEGER      NOT NULL,
  "nom"            VARCHAR(255) NOT NULL,
  "mime"           VARCHAR(255) NOT NULL,
  "chiffre"        BOOLEAN      NOT NULL DEFAULT false,
  "duree_ms"       INTEGER,
  -- SHA-256 (hex) du fichier ENTIER, vérifié à l'assemblage. Facultatif.
  "empreinte"      CHAR(64),
  "statut"         VARCHAR(16)  NOT NULL DEFAULT 'en_cours',
  "media_id"       UUID
    REFERENCES "media_files"("id") ON DELETE SET NULL,
  "cree_le"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Dernière activité : sert à l'expiration (7 jours sans morceau).
  "maj_le"         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "envoi_morceaux_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "envoi_morceaux_statut" CHECK ("statut" IN ('en_cours', 'assemblage', 'termine')),
  CONSTRAINT "envoi_morceaux_taille" CHECK ("taille" > 0 AND "taille_morceau" > 0),
  -- 🔴 LE DÉCOUPAGE EST TENU PAR LA BASE : le nombre de morceaux est celui que
  -- donnent la taille et la taille d'un morceau, et aucun autre. Un calcul
  -- faux dans le code serait refusé ici plutôt que de produire un envoi qui ne
  -- se termine jamais.
  CONSTRAINT "envoi_morceaux_decoupage"
    CHECK ("nb_morceaux" = ("taille" + "taille_morceau" - 1) / "taille_morceau")
);

CREATE INDEX IF NOT EXISTS "idx_envoi_morceaux_proprietaire"
  ON "envoi_morceaux" ("alanyaID", "statut");
CREATE INDEX IF NOT EXISTS "idx_envoi_morceaux_expiration"
  ON "envoi_morceaux" ("statut", "maj_le");

CREATE TABLE IF NOT EXISTS "envoi_morceaux_recus" (
  "envoi_id" UUID    NOT NULL
    REFERENCES "envoi_morceaux"("id") ON DELETE CASCADE,
  "indice"   INTEGER NOT NULL,
  CONSTRAINT "envoi_morceaux_recus_pkey" PRIMARY KEY ("envoi_id", "indice"),
  CONSTRAINT "envoi_morceaux_recus_indice" CHECK ("indice" >= 0)
);
