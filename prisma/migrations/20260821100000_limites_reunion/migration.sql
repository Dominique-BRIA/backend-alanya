-- Table: limite_reunion
-- Plafond de participants d'une reunion — combien de personnes tiennent dans
-- une meme salle, en audio et en video.
--
-- POURQUOI un plafond, et pourquoi il n'est pas negociable a la legere. Les
-- reunions Alanya sont en MAILLAGE : il n'y a pas de serveur qui melange les
-- flux, chaque participant ouvre une connexion vers CHACUN des autres et
-- encode son flux autant de fois qu'il a d'interlocuteurs. A n personnes,
-- chacun tient n-1 connexions, n-1 encodages et n-1 decodages. Le cout ne pese
-- donc pas sur nos serveurs, qui ne voient rien passer, mais sur le telephone
-- et l'ordinateur de chaque participant. Au-dela d'un certain nombre, ce sont
-- leurs machines qui lachent — pas la notre. C'est une borne PHYSIQUE, pas une
-- offre commerciale.
--
-- POURQUOI 9 ET 6. Un flux audio Opus coute environ 40 kbit/s ; un flux video
-- meme modeste, autour de 300 kbit/s, et il mobilise un encodeur par
-- destinataire. A 9 en audio, chacun emet 8 x 40 kbit/s, soit ~320 kbit/s
-- montants : tenable partout, y compris en mobile. A 6 en video, chacun emet
-- 5 x 300 kbit/s, soit ~1,5 Mbit/s montants et 5 decodages simultanes : c'est
-- deja le haut de ce qu'un portable de milieu de gamme soutient sans chauffer.
-- Les deux chiffres different d'un facteur proche de celui qui separe les deux
-- debits — ce n'est pas un hasard, c'est la meme contrainte appliquee a deux
-- couts.
--
-- POURQUOI CETTE TABLE, plutot que deux constantes dans le code. Le plafond
-- doit pouvoir bouger sans redeploiement : une entreprise equipee de postes
-- fixes sur reseau filaire supporte davantage, une flotte de telephones
-- d'entree de gamme supporte moins. Les valeurs par defaut existent AUSSI en
-- dur dans src/lib/limites-reunion.ts, pour qu'une base neuve ou une table
-- vide reste fonctionnelle ; la ligne globale inseree plus bas ne les remplace
-- pas, elle les rend VISIBLES et modifiables.
--
-- PORTEE. "idcompany" NUL = ligne globale, valable pour toute l'application ;
-- renseigne = plafond propre a une entreprise, qui prime pour ses
-- utilisateurs. Deux niveaux, pas trois : il n'existe aucun echelon entre
-- l'entreprise et l'application.

CREATE TABLE IF NOT EXISTS "limite_reunion" (
    "idlimite" SERIAL NOT NULL,
    -- NUL = portee globale. Voir l'index partiel plus bas : c'est lui, et non
    -- une contrainte UNIQUE ordinaire, qui interdit une SECONDE ligne globale.
    "idcompany" INTEGER,
    -- Participants maximum, ORGANISATEUR COMPRIS. SMALLINT : on parle de
    -- dizaines de personnes au plus, un INTEGER serait quatre octets pour rien
    -- et laisserait croire que des valeurs a six chiffres ont un sens ici.
    "max_audio" SMALLINT NOT NULL DEFAULT 9,
    "max_video" SMALLINT NOT NULL DEFAULT 6,
    -- Auteur DECLARE du dernier changement — texte libre, pas une cle
    -- etrangere : aucune session de superuser n'existe dans ce depot, l'auteur
    -- n'est donc pas authentifie. Voir src/lib/limites-reunion.ts.
    "modifie_par" VARCHAR(120),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Le DEFAULT sert l'INSERT de cette migration et toute retouche faite en
    -- SQL a la main ; ensuite c'est Prisma (@updatedAt) qui pose la valeur a
    -- chaque ecriture. ⚠️ `@updatedAt` ne declare AUCUN defaut cote schema :
    -- un futur `migrate dev` pourra vouloir retirer celui-ci. Sans effet sur
    -- l'application — mais un INSERT manuel devra alors fournir la colonne.
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "limite_reunion_pkey" PRIMARY KEY ("idlimite")
);

-- Un seul plafond par entreprise. Le nom est celui que Prisma donnerait a
-- l'index de `@unique` sur `idCompany` : le garder identique evite qu'un
-- futur `migrate dev` ne croie a une derive et ne le recree.
CREATE UNIQUE INDEX IF NOT EXISTS "limite_reunion_idcompany_key"
    ON "limite_reunion"("idcompany");

-- Une seule ligne GLOBALE. L'index ci-dessus ne l'assure PAS : PostgreSQL
-- traite deux NULL comme distincts, et accepterait donc autant de lignes
-- globales qu'on en insere — deux verites pour une meme portee, un plafond
-- qui depend de l'ordre de lecture. L'index unique PARTIEL sur une expression
-- constante est la reponse standard : au plus une ligne peut satisfaire
-- "idcompany" IS NULL.
--
-- ⚠️ Le langage de schema Prisma ne sait pas exprimer un index partiel : cet
-- index n'apparait donc pas dans schema.prisma, et un `prisma migrate dev` ou
-- un `db push` le verra comme une derive et voudra le supprimer. S'il
-- disparait, le reposer.
CREATE UNIQUE INDEX IF NOT EXISTS "limite_reunion_globale_unique"
    ON "limite_reunion"((TRUE)) WHERE "idcompany" IS NULL;

-- La cle etrangere est posee sous garde : PostgreSQL n'a pas d'ADD CONSTRAINT
-- IF NOT EXISTS, et une relance de ce fichier sur une base ou la table existe
-- deja doit rester sans effet plutot que d'echouer a mi-course.
DO $$
BEGIN
    -- CASCADE : l'entreprise partie, son plafond n'a plus personne a borner.
    -- Ses utilisateurs, eux, ne sont pas emportes — "users"."idcompany" passe
    -- a NULL de son cote — et retombent donc sur le plafond global.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'limite_reunion_idcompany_fkey') THEN
        ALTER TABLE "limite_reunion"
            ADD CONSTRAINT "limite_reunion_idcompany_fkey"
            FOREIGN KEY ("idcompany") REFERENCES "company"("idcompany")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- La ligne globale, avec les valeurs par defaut.
--
-- Elle N'EST PAS redondante avec les constantes du code : celles-ci sont un
-- filet pour le cas ou la table serait vide ou illisible, celle-la est ce que
-- le superuser voit et modifie. Sans cette ligne, changer le plafond general
-- demanderait de deviner qu'il faut d'abord en CREER une, et rien a l'ecran ne
-- dirait quel plafond s'applique.
--
-- `WHERE NOT EXISTS` plutot qu'un `ON CONFLICT` : le conflit porterait sur un
-- index partiel, dont la syntaxe de cible est plus obscure que la condition
-- elle-meme. Relancer ce fichier ne cree pas de doublon et — c'est le point
-- important — n'ECRASE PAS un plafond global deja ajuste par le superuser.
INSERT INTO "limite_reunion" ("idcompany", "max_audio", "max_video", "modifie_par")
SELECT NULL, 9, 6, 'migration 20260821100000'
WHERE NOT EXISTS (
    SELECT 1 FROM "limite_reunion" WHERE "idcompany" IS NULL
);
