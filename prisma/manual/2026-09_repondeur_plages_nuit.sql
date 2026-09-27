-- ════════════════════════════════════════════════════════════════════════════
-- UNE PLAGE PEUT TRAVERSER MINUIT — « 21 h à 6 h »
-- ════════════════════════════════════════════════════════════════════════════
--
-- 🐛 CONSTATÉ PAR LE USER LE 26/09/2026 : « j'ai essayé de mettre un répondeur
-- de 21 h à 6 h, ça n'a pas pris ».
--
-- Ce n'était pas un problème de format. C'était un cas jamais prévu, refusé à
-- CINQ endroits indépendants — l'écran web, l'écran mobile, la route, cette
-- contrainte, et la règle qui évalue la plage. Chacun disait la même chose :
-- « une fin ne peut pas précéder un début ». C'est vrai sur une horloge ; c'est
-- faux pour une nuit.
--
-- 🔴 CE QUE `fin_min <= debut_min` VEUT DIRE MAINTENANT : la plage traverse
-- minuit. Elle couvre la fin du jour choisi, de `debut_min` à 24 h, PUIS le
-- début du lendemain, de 0 h à `fin_min`. « Lundi 21 h → 6 h » veut donc dire
-- « lundi soir jusqu'au mardi matin », ce que tout le monde entend en le disant.
--
-- ⚠️ L'ÉGALITÉ RESTE REFUSÉE, et c'est la seule chose qu'on garde. `21 h → 21 h`
-- est ambigu : zéro minute, ou vingt-quatre heures ? Deux lectures défendables,
-- donc aucune. Un utilisateur qui veut la journée entière saisit 0 h → 24 h.
--
-- ⚠️ CE FICHIER NE TOUCHE PAS AUX LIGNES EXISTANTES. Toutes respectent déjà
-- l'ancienne règle, plus stricte : elles restent valides sous la nouvelle.

DO $$
BEGIN
    -- La contrainte d'origine, telle que `2026-09_repondeur_plages.sql` la pose
    -- sur une base neuve. On la retire pour la remplacer — jamais l'inverse : une
    -- table sans contrainte, même une seconde, accepterait n'importe quoi.
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'repondeur_plage_bornes_ck'
    ) THEN
        ALTER TABLE "repondeur_plage" DROP CONSTRAINT "repondeur_plage_bornes_ck";
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'repondeur_plage_bornes_nuit_ck'
    ) THEN
        ALTER TABLE "repondeur_plage"
            ADD CONSTRAINT "repondeur_plage_bornes_nuit_ck" CHECK (
                "debut_min" BETWEEN 0 AND 1439
                AND "fin_min" BETWEEN 1 AND 1440
                -- Seule l'égalité est interdite : `fin < debut` signifie
                -- désormais « traverse minuit ».
                AND "fin_min" <> "debut_min"
            );
    END IF;
END
$$;

COMMENT ON COLUMN "repondeur_plage"."fin_min" IS
    'Minutes depuis minuit. Si <= debut_min, la plage TRAVERSE MINUIT : elle '
    'couvre debut_min→24h le jour choisi, puis 0h→fin_min le lendemain.';
