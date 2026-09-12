-- L'ACCUEIL D'ABSENCE N'EXISTE PLUS — un seul accueil, dans les deux modes.
--
-- 🔴 REVIENT SUR UNE COLONNE AJOUTÉE LA VEILLE, et c'est volontaire.
--
-- `repondeur_accueil.absence` permettait de désigner un second message, réservé
-- au mode absence. L'idée se défendait sur le papier — « je suis en réunion » ne
-- dit pas ce que dit « laissez un message » — mais à l'écran elle donnait un
-- bouton de plus sur chaque accueil, dont personne ne pouvait deviner l'effet.
--
-- Le répondeur n'a qu'UN message actif, et c'est celui-là qu'on entend. Le mode
-- change QUAND on l'entend — au bout de trente secondes, ou tout de suite — pas
-- LEQUEL on entend. Changer de message, c'est changer l'accueil actif.
--
-- ⚠️ ON SUPPRIME PLUTÔT QUE DE LAISSER DORMIR. Une colonne sans usage finit par
-- être relue comme une règle : le prochain à la trouver se demandera ce qu'elle
-- gouverne, et pourra même la remplir « par cohérence ».

DROP INDEX IF EXISTS "repondeur_accueil_absence_unique";

ALTER TABLE "repondeur_accueil" DROP COLUMN IF EXISTS "absence";
