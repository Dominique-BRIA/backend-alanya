-- LES QUATRE LISTES PAR DEFAUT DEVIENNENT RECONNAISSABLES.
--
-- 🔴 POURQUOI UNE COLONNE, ALORS QU'ON S'EN PASSAIT. Les quatre listes semees a
-- la creation d'un compte etaient des listes ORDINAIRES : rien ne les
-- distinguait, et c'etait un choix — celui qui n'en voulait pas pouvait les
-- supprimer pour de bon. La demande a change : elles doivent maintenant etre
-- presentes chez tout le monde, modifiables mais NON SUPPRIMABLES. Sans marque
-- en base, le serveur ne peut pas refuser leur suppression, et le client ne peut
-- pas masquer le bouton.
--
-- ⚠️ UNE CLE, ET NON UN BOOLEEN. « Est-ce une liste par defaut » ne suffit pas :
-- il faut savoir LAQUELLE, sinon le semeur ne peut pas dire si « Bureau » existe
-- deja chez ce compte apres que l'utilisateur l'a renommee en « Travail ». Avec
-- la cle, un renommage reste sans effet sur l'idempotence.
--
-- ⚠️ NULL POUR LES LISTES ORDINAIRES, et l'index unique est donc PARTIEL :
-- PostgreSQL considere deux NULL comme distincts, mais un index unique complet
-- sur (compte, cle) aurait quand meme empeche... rien, en realite. Le partiel est
-- surtout la pour ne pas indexer des millions de NULL sans utilite.

ALTER TABLE "contactList"
    ADD COLUMN IF NOT EXISTS "cle" VARCHAR(20);

COMMENT ON COLUMN "contactList"."cle" IS
    'Liste creee d office : bureau | amis | confiance | famille. NULL = liste ordinaire, supprimable.';

-- Une seule liste par cle et par compte : le semeur s appuie dessus pour etre
-- rejouable sans creer de doublon.
CREATE UNIQUE INDEX IF NOT EXISTS "contactList_alanyaID_cle_key"
    ON "contactList"("alanyaID", "cle")
    WHERE "cle" IS NOT NULL;

-- ⚠️ RATTRAPAGE DES LISTES DEJA SEMEES, par leur nom d origine.
--
-- Les comptes crees avant cette migration portent les quatre listes sans cle.
-- On les marque a partir du nom EXACT que le semeur leur donnait, et seulement
-- s il n y a pas deja une liste portant cette cle.
--
-- ⚠️ CE RATTRAPAGE EST IMPARFAIT, ET C EST ASSUME : une liste que l utilisateur
-- avait renommee ne sera pas reconnue, et une liste qu il a lui-meme appelee
-- « Amis » le sera a tort — elle deviendra non supprimable. Le second cas est le
-- seul genant ; il se repare en renommant la liste, et il vaut mieux que
-- l inverse, ou les quatre listes de tout le monde resteraient supprimables.
DO $$
DECLARE
    paire RECORD;
BEGIN
    FOR paire IN
        SELECT * FROM (VALUES
            ('Bureau', 'bureau'),
            ('Amis', 'amis'),
            ('Confiance', 'confiance'),
            ('Famille', 'famille')
        ) AS t(libelle, cle)
    LOOP
        UPDATE "contactList" c
           SET "cle" = paire.cle
         WHERE c."libelle" = paire.libelle
           AND c."cle" IS NULL
           AND NOT EXISTS (
               SELECT 1 FROM "contactList" d
                WHERE d."alanyaID" = c."alanyaID"
                  AND d."cle" = paire.cle
           );
    END LOOP;
END $$;
