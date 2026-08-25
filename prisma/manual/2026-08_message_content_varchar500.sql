-- =============================================================
-- message.content : TEXT -> VARCHAR(500)
-- =============================================================
-- Demandé le 25/08/2026. La perte de la fin des messages les plus longs est
-- ASSUMÉE — le projet est encore en phase de développement.
--
-- ⚠️ C'EST UN RÉTRÉCISSEMENT SUR UNE TABLE PLEINE. PostgreSQL refuse
-- l'opération si une seule valeur dépasse la nouvelle longueur ; le `USING
-- left(...)` ci-dessous coupe donc explicitement, au lieu de laisser la
-- migration s'arrêter là. Mesuré en base de dev avant écriture de ce fichier :
-- 1 387 messages avec du texte, 8 au-dessus de 500 caractères, le plus long à
-- 14 866. Le contrôle est REJOUÉ à l'exécution plutôt que tenu pour acquis :
-- ce fichier est rejoué à chaque déploiement, et la prod n'est pas la dev.
--
-- 🔴 LES CHARGES CONTACT ET LOCATION NE PEUVENT PAS ÊTRE COUPÉES.
--
-- Leur `content` n'est pas du texte mais du JSON (voir
-- `src/lib/message-payload.mjs`) : en retirer la fin produit une chaîne que
-- `JSON.parse` rejette, donc un message que plus AUCUN client ne saura jamais
-- afficher — l'information étant détruite en base, c'est sans retour. Une telle
-- ligne fait donc ÉCHOUER cette migration au lieu d'être mutilée en silence.
-- Aucune n'existait en dev au 25/08/2026 (0 message CONTACT ou LOCATION).
-- Si l'échec se produit en prod, le choix appartient à un humain : supprimer
-- ces messages, ou renoncer au rétrécissement.
--
-- Côté code, toute écriture passe désormais par `tronqueContenu` : PostgreSQL
-- REFUSE une valeur trop longue (erreur 22001), il ne la coupe pas. Sans cette
-- fonction, chaque message un peu long serait devenu un échec d'envoi.
--
-- Application : psql -h localhost -U alanyavox -d alanya -v ON_ERROR_STOP=1 \
--                    -f prisma/manual/2026-08_message_content_varchar500.sql

DO $$
DECLARE
  charges_illisibles INTEGER;
  textes_coupes      INTEGER;
BEGIN
  -- Idempotence : `character_maximum_length` vaut NULL pour un TEXT, 500 une
  -- fois la migration passée. Le bloc entier est donc sauté au second passage.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'message' AND column_name = 'content'
      AND character_maximum_length IS DISTINCT FROM 500
  ) THEN

    -- 1. Refus : une charge structurée trop longue ne se coupe pas.
    --    ⚠️ `"type"::text` ET NON `"type" IN ('CONTACT', …)`. `MessageType` est
    --    un enum, et une base où `2026-08_message_type_contact_location.sql`
    --    n'a pas encore été rejoué ne connaît PAS ces deux valeurs : la
    --    comparaison directe y lève « invalid input value for enum » et fait
    --    échouer le déploiement entier. C'est le cas de la base de dev au
    --    25/08/2026, découvert par `prisma migrate diff`. Le passage par le
    --    texte compare des chaînes et ne suppose rien du contenu de l'enum.
    SELECT count(*) INTO charges_illisibles
      FROM "message"
     WHERE "type"::text IN ('CONTACT', 'LOCATION')
       AND "content" IS NOT NULL
       AND length("content") > 500;

    IF charges_illisibles > 0 THEN
      RAISE EXCEPTION
        'Rétrécissement impossible : % message(s) CONTACT/LOCATION portent une charge JSON de plus de 500 caractères. La couper la rendrait illisible pour toujours. Les supprimer ou renoncer au VARCHAR(500).',
        charges_illisibles;
    END IF;

    -- 2. Journalise ce que l'on s'apprête à perdre. `RAISE NOTICE` et non une
    --    table de trace : la perte est acceptée, on veut seulement qu'elle soit
    --    LISIBLE dans la sortie du déploiement, pas silencieuse.
    SELECT count(*) INTO textes_coupes
      FROM "message"
     WHERE "content" IS NOT NULL AND length("content") > 500;

    IF textes_coupes > 0 THEN
      RAISE NOTICE 'message.content : % message(s) vont être coupés à 500 caractères.', textes_coupes;
    END IF;

    -- 3. Le rétrécissement. `USING left(...)` fait la coupe explicitement :
    --    sans lui, PostgreSQL refuserait l'ALTER dès la première valeur longue.
    ALTER TABLE "message"
      ALTER COLUMN "content" TYPE VARCHAR(500) USING left("content", 500);

  END IF;
END $$;
