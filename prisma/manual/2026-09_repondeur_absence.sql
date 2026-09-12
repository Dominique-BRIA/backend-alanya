-- LE RÉPONDEUR PREND UNE DURÉE, ET CHANGE DE COMPORTEMENT.
--
-- Deux modes, et ce qui les distingue tient dans UNE date.
--
--   • Sans date — le mode par défaut. Ça sonne trente secondes, personne ne
--     décroche, l'accueil se joue. C'est ce qui existe déjà.
--
--   • Avec une date dans le futur — le mode absence. L'appel ne fait sonner
--     PERSONNE : le serveur répond l'accueil à l'appelant, comme il répond déjà
--     le menu d'un centre d'appels. Le destinataire a demandé la paix, il l'a.
--
-- ⚠️ UNE DATE DE FIN, ET NON UNE DURÉE EN MINUTES. Une durée oblige à retenir
-- quand elle a commencé — donc à écrire un second champ, et à les garder
-- d'accord. Une date se compare à `now()` et se périme toute seule : aucune
-- tâche planifiée, aucun minuteur, rien à réveiller. Le retour au mode par
-- défaut n'est pas un évènement, c'est l'absence d'un fait.

ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "repondeur_jusqu_a" TIMESTAMPTZ;

COMMENT ON COLUMN "users"."repondeur_jusqu_a" IS
    'Fin du mode absence. NULL ou passée = mode par défaut (sonnerie puis accueil).';

-- ⚠️ INDEX PARTIEL, sur les seules lignes qui portent une date. Les comptes en
-- absence sont une poignée à un instant donné ; indexer les autres reviendrait
-- à payer pour des NULL que la question ne concerne jamais. Cette colonne est
-- lue À CHAQUE APPEL, avant de faire sonner : elle doit être bon marché.
CREATE INDEX IF NOT EXISTS "users_repondeur_jusqu_a_idx"
    ON "users" ("repondeur_jusqu_a")
    WHERE "repondeur_jusqu_a" IS NOT NULL;

-- L'ACCUEIL DE L'ABSENCE EST UN AUTRE ACCUEIL.
--
-- « Je ne suis pas disponible, laissez un message » et « je suis en réunion
-- jusqu'à 15 h » ne disent pas la même chose, et l'on ne veut pas réenregistrer
-- le second à chaque réunion. Un accueil de la bibliothèque est donc désigné
-- pour l'absence, à côté de celui de tous les jours.
--
-- ⚠️ UNE COLONNE À PART, ET NON UN « TYPE » À TROIS VALEURS. Le même accueil
-- peut très bien servir dans les deux cas : avec un type unique il faudrait le
-- dupliquer, et deux lignes pour un seul fichier se désaccordent tôt ou tard.
ALTER TABLE "repondeur_accueil"
    ADD COLUMN IF NOT EXISTS "absence" SMALLINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN "repondeur_accueil"."absence" IS
    '1 = accueil joué pendant le mode absence. Au plus un par compte.';

-- Même garantie que pour `actif`, tenue par la BASE et non par le code : au
-- plus un accueil d'absence par compte. Sans cet index, « désigner » devrait
-- éteindre les autres SANS FAILLIR, à chaque fois, dans chaque chemin — une
-- règle qu'on finit toujours par oublier quelque part.
CREATE UNIQUE INDEX IF NOT EXISTS "repondeur_accueil_absence_unique"
    ON "repondeur_accueil" ("alanyaID")
    WHERE "absence" = 1;

-- ⚠️ AUCUNE REPRISE DE DONNÉES ICI, et c'est volontaire. Désigner d'office
-- l'accueil courant comme accueil d'absence ferait jouer « je suis en congés »
-- à quelqu'un qui n'a jamais demandé de mode absence. Tant que rien n'est
-- désigné, le mode absence retombe sur l'accueil de tous les jours — c'est le
-- code qui le décide, et c'est un repli, pas une préférence.
