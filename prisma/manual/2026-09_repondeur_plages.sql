-- LE RÉPONDEUR PROGRAMMÉ — un jour, une plage horaire, et rien de plus.
--
-- Troisième mode, à côté du défaut (trente secondes de sonnerie) et de la durée
-- fixe (« absent pour trois heures ») : « tous les lundis de 10 h à 12 h ».
--
-- ⚠️ UNE LIGNE PAR JOUR, ET NON UN MASQUE DE JOURS. « Du lundi au vendredi de
-- 10 h à 12 h » s'écrit en cinq lignes. C'est plus verbeux à l'écriture, et
-- c'est le bon choix : les plages diffèrent d'un jour à l'autre — lundi
-- 10 h-12 h, mardi 14 h-16 h — et un masque obligerait alors à créer plusieurs
-- entrées de toute façon, avec en prime deux façons d'exprimer la même chose.
-- Une ligne = un jour = une plage. Supprimer le mardi ne touche pas au lundi.

CREATE TABLE IF NOT EXISTS "repondeur_plage" (
    "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
    "alanyaID"  UUID NOT NULL,

    -- 0 = dimanche … 6 = samedi, la convention de `Date.getDay()`. Le même
    -- nombre des deux côtés : traduire d'une convention à l'autre entre le
    -- client et le serveur est une erreur qui ne se voit qu'un jour sur sept.
    "jour"      SMALLINT NOT NULL,

    -- Minutes depuis minuit, dans le FUSEAU DE LA LIGNE. 600 = 10 h 00.
    -- Deux entiers plutôt que deux heures : une heure sans date n'existe pas en
    -- SQL, et un `TIME` aurait porté un fuseau implicite — celui du serveur —
    -- qui n'est presque jamais celui de l'utilisateur.
    "debut_min" SMALLINT NOT NULL,
    "fin_min"   SMALLINT NOT NULL,

    /*
     * ⚠️ LE FUSEAU EST STOCKÉ, ET C'EST INDISPENSABLE.
     *
     * « Lundi 10 h » ne veut rien dire sans dire 10 h OÙ. Le serveur peut être
     * en UTC, l'utilisateur à Douala, et l'appelant à Paris : sans ce champ, une
     * plage posée pour 10 h se déclencherait à 9 h ou 11 h selon l'humeur de
     * l'hébergeur.
     *
     * Un NOM de zone (« Africa/Douala »), et non un décalage en heures : un
     * décalage fige l'heure d'été au moment où la plage a été créée, et se
     * trompe d'une heure à chaque changement. Le nom, lui, reste juste.
     */
    "fuseau"    VARCHAR(64) NOT NULL DEFAULT 'UTC',

    -- L'accueil à jouer pendant cette plage. NULL = celui qui est actif au
    -- moment de l'appel, ce qui est le cas courant et évite d'avoir à choisir.
    "accueilID" UUID,

    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    /*
     * 🔴 L'AUTO-SUPPRESSION EST UNE DATE, PAS UNE TÂCHE.
     *
     * Une programmation récurrente qu'on oublie d'éteindre bloque les appels
     * indéfiniment — et personne ne s'en aperçoit, puisque justement le
     * téléphone ne sonne plus. Elle cesse donc de s'appliquer d'elle-même au
     * bout de deux semaines.
     *
     * Une date dépassée répond « non » sans qu'aucun code ne tourne : pas de
     * tâche planifiée à surveiller, pas de balayage qui pourrait ne pas tourner
     * le jour où il faut. Et la ligne reste visible à l'écran, donc relançable
     * d'un clic — une suppression sèche aurait fait disparaître sans trace le
     * réglage qu'on cherchait à retrouver.
     */
    "expire_le" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "repondeur_plage_pkey" PRIMARY KEY ("id"),
    -- Bornes tenues par la BASE : une plage de 25 h ou finissant avant de
    -- commencer n'a pas de sens, et le code qui l'évalue ne doit pas avoir à
    -- s'en méfier.
    CONSTRAINT "repondeur_plage_jour_ck"  CHECK ("jour" BETWEEN 0 AND 6),
    CONSTRAINT "repondeur_plage_bornes_ck" CHECK (
        "debut_min" BETWEEN 0 AND 1439
        AND "fin_min" BETWEEN 1 AND 1440
        AND "fin_min" > "debut_min"
    )
);

-- ⚠️ LA CLE PRIMAIRE DE `users` S'APPELLE `alanyaID`, PAS `id`.
--
-- Le champ Prisma se nomme `id` — `@map("alanyaID")` — et c'est ce nom-la qu'on
-- lit partout dans le code. La COLONNE, elle, porte le nom du referentiel de
-- l'equipe. Un `REFERENCES "users"("id")` ecrit de memoire echoue donc a
-- l'application, et seulement a ce moment-la : rien dans le code TypeScript ne
-- l'aurait signale. C'est arrive le 18/09/2026.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repondeur_plage_alanyaID_fkey') THEN
        ALTER TABLE "repondeur_plage"
            ADD CONSTRAINT "repondeur_plage_alanyaID_fkey"
            FOREIGN KEY ("alanyaID") REFERENCES "users"("alanyaID") ON DELETE CASCADE;
    END IF;
    -- ⚠️ `SET NULL` ET NON `CASCADE` : supprimer un message d'accueil ne doit
    -- pas faire disparaître la programmation qui s'y référait. La plage reste,
    -- et retombe sur l'accueil actif — sans quoi quelqu'un qui fait le ménage
    -- dans ses accueils se retrouverait joignable un lundi matin sans l'avoir
    -- demandé, et sans rien pour le lui dire.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repondeur_plage_accueilID_fkey') THEN
        ALTER TABLE "repondeur_plage"
            ADD CONSTRAINT "repondeur_plage_accueilID_fkey"
            FOREIGN KEY ("accueilID") REFERENCES "repondeur_accueil"("id") ON DELETE SET NULL;
    END IF;
END $$;

-- La question posée À CHAQUE APPEL est « ce compte a-t-il une plage vivante ? ».
-- Elle doit coûter le moins possible : l'index porte le compte et la date de
-- péremption, et ne retient que les lignes encore valables.
CREATE INDEX IF NOT EXISTS "repondeur_plage_compte_idx"
    ON "repondeur_plage" ("alanyaID", "expire_le");
