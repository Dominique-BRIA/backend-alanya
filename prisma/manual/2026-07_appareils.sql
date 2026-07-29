-- =============================================================
-- Table « Appareil » — registre des appareils d'un compte
-- =============================================================
-- Issue du référentiel équipe. À ne pas confondre avec :
--   * userAccess   : JOURNAL des connexions (une ligne par connexion, jamais
--                    mise à jour) ;
--   * push_devices : jetons FCM pour l'envoi de notifications, sans état
--                    présentable à l'utilisateur.
-- Appareil est un REGISTRE : une ligne par appareil, mise à jour au fil de
-- l'eau. C'est elle qui alimente un écran « Appareils connectés ».
--
-- Conventions retenues :
--   typeDevice : 0 = web, 1 = Android, 2 = iOS, 3 = bureau
--   is_online  : 0 = hors ligne, 1 = en ligne
--   destroy    : 0 = actif, 1 = déconnecté à distance (effacement logique,
--                on conserve la ligne pour l'historique)
--
-- Les noms physiques (« create_at », « cookies_WebID », majuscules) reprennent
-- exactement le référentiel, d'où les guillemets. Les noms de champ Prisma,
-- eux, restent en camelCase via @map — même approche que l'harmonisation.
--
-- Application : psql -h localhost -U alanyavox -d alanya -v ON_ERROR_STOP=1 \
--                    -f prisma/manual/2026-07_appareils.sql

CREATE TABLE IF NOT EXISTS "Appareil" (
  "appareilID"    SERIAL PRIMARY KEY,
  -- Identifiant stable du navigateur, généré côté client et conservé en
  -- localStorage. Nul pour les appareils mobiles, qui n'en ont pas.
  "cookies_WebID" VARCHAR(255),
  "libelle"       VARCHAR(45)    NOT NULL DEFAULT 'Appareil',
  "is_online"     SMALLINT       NOT NULL DEFAULT 0,
  "create_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "typeDevice"    SMALLINT       NOT NULL DEFAULT 0,
  "lastLogin"     TIMESTAMPTZ(6),
  "system"        VARCHAR(45),
  -- Renommée depuis « alanyaID » le 29/07/2026 : ce registre sert le centre
  -- d'appels, la colonne désigne l'agent propriétaire. Voir
  -- 2026-07_rapport_chat.sql, qui effectue le renommage sur les bases déjà
  -- créées. CE FICHIER DÉCRIT L'ÉTAT CIBLE, pour qu'une base neuve soit
  -- construite directement au bon nom.
  "idAgent"       UUID           NOT NULL,
  "destroy"       SMALLINT       NOT NULL DEFAULT 0,
  CONSTRAINT "Appareil_idAgent_fkey"
    FOREIGN KEY ("idAgent") REFERENCES "users"("alanyaID") ON DELETE CASCADE
);

-- Unicité sur le COUPLE (navigateur, agent) et non sur le seul navigateur :
-- deux comptes utilisés tour à tour dans le même navigateur conservent chacun
-- leur entrée, au lieu de se voler la ligne à chaque connexion.
CREATE UNIQUE INDEX IF NOT EXISTS "Appareil_cookies_idAgent_key"
  ON "Appareil"("cookies_WebID", "idAgent");

-- Pour l'écran « Appareils connectés » : les actifs d'un compte, les plus
-- récemment vus en premier. Son préfixe gauche couvre aussi les recherches sur
-- le seul « idAgent » — un second index sur cette colonne serait redondant.
CREATE INDEX IF NOT EXISTS "Appareil_idAgent_destroy_idx"
  ON "Appareil"("idAgent", "destroy", "lastLogin" DESC);
