-- LES BOÎTES PERMANENTES DES GROUPES CHIFFRÉS (10/10/2026, cours chapitre 39).
--
-- Décision du user : « je veux qu'il n'y ait pas besoin qu'un admin soit
-- connecté pour qu'il ait les clés ». Le trousseau voyageait seulement dans
-- des enveloppes Signal À USAGE UNIQUE : un appareil qui la ratait (ancienne
-- application, relève perdue) devait attendre qu'un administrateur la renvoie.
--
-- Quand un administrateur distribue le trousseau, il dépose AUSSI, pour chaque
-- appareil de chaque membre, une copie SCELLÉE avec la clé d'identité de cet
-- appareil, et SIGNÉE par la sienne. Le serveur la garde ; l'appareil la relit
-- quand il veut. Le serveur ne peut pas l'ouvrir.
--
-- Une ligne par (groupe, membre, appareil) : chaque distribution REMPLACE la
-- boîte (elle porte toujours le trousseau entier). Supprimée au départ du membre
-- (routes `leave` et `members`).
--
-- ⚠️ REJOUABLE (IF NOT EXISTS) ; pas de transaction propre dans ce fichier.

CREATE TABLE IF NOT EXISTS "e2ee_boites" (
  "conv_id"           UUID        NOT NULL
    REFERENCES "conversation"("conversID") ON DELETE CASCADE,
  "alanyaID"          UUID        NOT NULL,
  "device_id"         INTEGER     NOT NULL,
  "expediteur_id"     UUID        NOT NULL,
  "expediteur_device" INTEGER     NOT NULL,
  "corps"             TEXT        NOT NULL,
  "maj_le"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "e2ee_boites_pkey" PRIMARY KEY ("conv_id", "alanyaID", "device_id"),
  -- Comme la copie personnelle : une borne contre l'abus, pas contre l'usage
  -- (~170 000 versions de clé).
  CONSTRAINT "e2ee_boites_corps_borne" CHECK (char_length("corps") <= 20000000)
);

CREATE INDEX IF NOT EXISTS "idx_e2ee_boites_destinataire"
  ON "e2ee_boites" ("alanyaID", "device_id");
