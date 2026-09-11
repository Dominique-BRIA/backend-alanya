-- LE RÉPONDEUR : message d'accueil par compte, et messagerie vocale rattachée à
-- l'appel manqué qui l'a provoquée.
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. LE MESSAGE VOCAL EST UN MESSAGE, PAS UNE TABLE À PART
-- ══════════════════════════════════════════════════════════════════════════
--
-- 🔴 POURQUOI PAS DE TABLE `voicemail_message`. Elle aurait fallu tout
-- reconstruire : un chemin de livraison, un etat lu/non-lu, une poussee de
-- notification, un rendu, une synchronisation multi-appareils, une suppression,
-- une recherche. La table `message` porte deja les sept, eprouves.
--
-- Un message vocal EST un message vocal. Il se distingue par une seule chose :
-- l'appel qu'il prolonge. D'ou cette colonne, et rien d'autre.
--
-- ⚠️ LE TYPE RESTE `AUDIO`, ON N'EN CREE PAS UN NOUVEAU. Un type `VOICEMAIL`
-- aurait ete plus explicite mais SE DEGRADE MAL : les clients qui ne le
-- connaissent pas — l'application mobile, les versions web deja installees —
-- font retomber un type inconnu sur « texte » et n'afficheraient RIEN
-- d'ecoutable. Avec `AUDIO`, ils affichent un message vocal ordinaire, ce qui
-- est exactement ce dont il s'agit ; seul le rattachement a l'appel leur
-- echappe.

ALTER TABLE "message"
    ADD COLUMN IF NOT EXISTS "callID" UUID;

COMMENT ON COLUMN "message"."callID" IS
    'Appel que ce message prolonge. Renseigne = messagerie vocale laissee apres un appel sans reponse. NULL = message ordinaire.';

-- ⚠️ `ON DELETE SET NULL` ET NON `CASCADE`. Supprimer un appel de l historique
-- ne doit pas EFFACER le message vocal qu il a laisse : le vocal appartient a
-- son destinataire, l appel n est que le contexte ou il est ne. Il redevient
-- alors un message vocal ordinaire, ce qu il est deja pour les clients qui ne
-- lisent pas cette colonne.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'message_callID_fkey'
    ) THEN
        ALTER TABLE "message"
            ADD CONSTRAINT "message_callID_fkey"
            FOREIGN KEY ("callID") REFERENCES "calls"("id") ON DELETE SET NULL;
    END IF;
END $$;

-- « Cet appel a-t-il deja sa messagerie vocale ? » — la question posee a chaque
-- depot, et la seule garantie qu un appelant n en laisse pas dix sur le meme
-- appel manque.
--
-- ⚠️ UNIQUE ET PARTIEL : les messages ordinaires portent tous NULL, et un index
-- unique complet les aurait tous mis en collision.
CREATE UNIQUE INDEX IF NOT EXISTS "message_callID_key"
    ON "message"("callID")
    WHERE "callID" IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. LE MESSAGE D'ACCUEIL EST PORTÉ PAR LE COMPTE
-- ══════════════════════════════════════════════════════════════════════════
--
-- 🔴 POURQUOI PAS DE TABLE `voicemail_greeting` AVEC UN DRAPEAU « ACTIF ».
-- « Un seul enregistrement actif par utilisateur » serait alors une REGLE a
-- faire respecter — donc a oublier un jour, laissant deux accueils actifs et un
-- comportement qui depend de l ordre de lecture. Ici la question ne se pose
-- pas : il y a une colonne, donc un accueil.
--
-- Meme choix que `avatar_url`, `read_receipts` ou `last_seen_visibility`, qui
-- vivent deja sur le compte pour la meme raison.
--
-- L historique des accueils precedents n interesse personne : on n en garde pas.

ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "repondeur_actif" SMALLINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN "users"."repondeur_actif" IS
    '1 = le repondeur prend les appels sans reponse, 0 = non. Par defaut inactif.';

-- ⚠️ LE MEDIA EST REFERENCE, PAS RECOPIE. La duree, le type MIME, la taille et
-- le chemin de stockage vivent deja dans `media_files` : les redoubler ici
-- aurait cree deux verites, et celle-ci aurait vieilli la premiere.
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "repondeur_media_id" UUID;

COMMENT ON COLUMN "users"."repondeur_media_id" IS
    'Media du message d accueil, ou NULL si aucun n a ete enregistre.';

-- ⚠️ `ON DELETE SET NULL` : supprimer le fichier doit eteindre l accueil, pas
-- supprimer le COMPTE. Un `CASCADE` ici aurait efface l utilisateur avec son
-- enregistrement — la faute la plus couteuse de tout ce fichier.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_repondeur_media_id_fkey'
    ) THEN
        ALTER TABLE "users"
            ADD CONSTRAINT "users_repondeur_media_id_fkey"
            FOREIGN KEY ("repondeur_media_id") REFERENCES "media_files"("id") ON DELETE SET NULL;
    END IF;
END $$;
