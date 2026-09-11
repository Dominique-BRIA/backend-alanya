-- PLUSIEURS MESSAGES D'ACCUEIL PAR COMPTE, DONT UN SEUL ACTIF.
--
-- 🔴 CORRECTION D'UN CHOIX QUE J'AVAIS FAIT, ET QUI ÉTAIT FAUX.
--
-- La migration précédente posait l'accueil sur le compte — une colonne
-- `repondeur_media_id` — en faisant valoir qu'« un seul accueil actif » devenait
-- alors vrai par construction plutôt que par une règle à faire respecter.
-- L'argument tenait tant qu'il n'y avait qu'un accueil. Le besoin réel est
-- d'en garder PLUSIEURS et d'en choisir un selon le contexte — congés, bureau,
-- week-end. Une colonne ne peut pas porter une liste.
--
-- ⚠️ L'ARGUMENT D'ORIGINE N'EST PAS ABANDONNÉ POUR AUTANT : « un seul actif »
-- reste garanti par la BASE, via un index unique PARTIEL sur le propriétaire
-- là où `actif = 1`. La règle n'est donc toujours pas à la charge du code.

CREATE TABLE IF NOT EXISTS "repondeur_accueil" (
    "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
    "alanyaID"  UUID NOT NULL,
    -- Le média porte déjà la durée, le type MIME, la taille et le chemin : les
    -- redoubler ici créerait deux vérités, et celle-ci vieillirait la première.
    "mediaID"   UUID NOT NULL,
    -- Nom donné par l'utilisateur. C'est ce qui rend une liste utilisable : sans
    -- lui, cinq accueils se ressemblent tous et il faut les écouter un par un
    -- pour savoir lequel on choisit.
    "libelle"   VARCHAR(60),
    -- 1 = c'est celui que les appelants entendent. Au plus un par compte.
    "actif"     SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repondeur_accueil_pkey" PRIMARY KEY ("id")
);

-- ⚠️ `ON DELETE CASCADE` SUR LE COMPTE, mais pas sur le média : supprimer un
-- compte emporte ses accueils, ce qui est juste ; supprimer le FICHIER d'un
-- accueil doit en revanche faire disparaître l'accueil, pas le compte. C'est
-- pourquoi `mediaID` est NOT NULL et cascade lui aussi — un accueil sans son
-- fichier ne serait qu'une ligne morte qui promettrait un son inexistant.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repondeur_accueil_alanyaID_fkey') THEN
        ALTER TABLE "repondeur_accueil"
            ADD CONSTRAINT "repondeur_accueil_alanyaID_fkey"
            FOREIGN KEY ("alanyaID") REFERENCES "users"("alanyaID") ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repondeur_accueil_mediaID_fkey') THEN
        ALTER TABLE "repondeur_accueil"
            ADD CONSTRAINT "repondeur_accueil_mediaID_fkey"
            FOREIGN KEY ("mediaID") REFERENCES "media_files"("id") ON DELETE CASCADE;
    END IF;
END $$;

-- « Mes accueils » — la seule lecture de départ.
CREATE INDEX IF NOT EXISTS "repondeur_accueil_alanyaID_idx"
    ON "repondeur_accueil"("alanyaID");

-- 🔴 UN SEUL ACTIF PAR COMPTE, GARANTI PAR LA BASE.
--
-- Partiel : les accueils inactifs portent tous 0 et un index complet les aurait
-- tous mis en collision. Sans cet index, « activer » devrait éteindre les autres
-- dans le code — donc un jour l'oublier, laisser deux accueils actifs, et faire
-- dépendre ce que l'appelant entend de l'ordre de lecture des lignes.
CREATE UNIQUE INDEX IF NOT EXISTS "repondeur_accueil_actif_key"
    ON "repondeur_accueil"("alanyaID")
    WHERE "actif" = 1;

-- ══════════════════════════════════════════════════════════════════════════
-- REPRISE DE L'ACCUEIL DÉJÀ ENREGISTRÉ
-- ══════════════════════════════════════════════════════════════════════════
--
-- ⚠️ SANS CE TRANSFERT, QUICONQUE A DÉJÀ ENREGISTRÉ SON ACCUEIL LE PERDRAIT
-- sans que rien ne le dise — et son répondeur deviendrait muet tout en se
-- déclarant actif. Le transfert est idempotent : il ne fait rien si le compte a
-- déjà une ligne.
INSERT INTO "repondeur_accueil" ("alanyaID", "mediaID", "actif")
SELECT u."alanyaID", u."repondeur_media_id", 1
  FROM "users" u
 WHERE u."repondeur_media_id" IS NOT NULL
   AND NOT EXISTS (
       SELECT 1 FROM "repondeur_accueil" a WHERE a."alanyaID" = u."alanyaID"
   );

-- La colonne n'a plus d'emploi : la table la remplace entièrement, et la
-- laisser donnerait deux endroits où chercher l'accueil actif — avec la
-- certitude qu'ils divergeraient.
ALTER TABLE "users" DROP COLUMN IF EXISTS "repondeur_media_id";
