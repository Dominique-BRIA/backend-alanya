-- =============================================================
-- MENTIONS DANS LES GROUPES (@)
-- =============================================================
-- Demandé le 31/08/2026. Écrire « @Dominique » dans un groupe désigne une
-- PERSONNE, pas une chaîne de caractères : le message porte donc, à côté de son
-- texte, la liste des comptes réellement visés.
--
-- 🔴 UNE TABLE À PART, ET PAS DES MARQUEURS DANS LE TEXTE. On aurait pu écrire
-- « @[uuid|Dominique] » dans `content` ; trois raisons l'excluent :
--
--   1. `message.content` est un VARCHAR(500). Un identifiant fait 36
--      caractères : trois mentions mangeraient un cinquième du message que
--      l'utilisateur a le droit d'écrire ;
--   2. tout ce qui lit le texte le lirait de travers — l'aperçu de la liste des
--      discussions, la recherche, la traduction automatique, et le rendu de
--      tout client plus ancien, qui afficherait la syntaxe brute ;
--   3. le texte resterait juste sans la table, alors qu'un marqueur cassé
--      salirait le message pour toujours.
--
-- Le texte garde donc « @Dominique » en clair. Un client qui ignore les
-- mentions affiche une phrase normale — dégradation propre, jamais de dégât.
--
-- COLONNES.
--   `idMessage` : le message porteur ; l'effacer emporte ses mentions.
--   `userId`    : le compte visé. C'est LUI qui fait la mention, jamais le nom.
--   `libelle`   : le texte inséré, SANS le « @ » — « Dominique ».
--
-- ⚠️ POURQUOI `libelle` EST STOCKÉ ALORS QUE LE NOM VIT DANS `users`. Deux
-- raisons, et aucune n'est du confort :
--
--   - c'est le texte qu'il faut RETROUVER dans le message pour le mettre en
--     évidence. Le pseudo du compte peut changer après coup ; le message, lui,
--     dit encore « @Dominique », et surligner d'après le pseudo courant ne
--     trouverait plus rien ;
--   - une personne RETIRÉE du groupe, ou dont le compte disparaît, laisse un
--     message qui doit rester lisible. Le libellé fige ce qui a été écrit.
--
-- ⚠️ PAS DE CLÉ ÉTRANGÈRE VERS `users` À DESSEIN. La base est partagée avec un
-- second système, et un compte peut y être effacé par un chemin que nous ne
-- contrôlons pas. Une contrainte ferait alors échouer cette suppression — ou
-- emporterait le message. Un `userId` orphelin est ici un cas NORMAL : le
-- client affiche le libellé figé, et la mention ne notifie plus personne.
--
-- UNICITÉ (idMessage, userId) : mentionner deux fois la même personne dans un
-- message ne la notifie pas deux fois. Le texte peut porter « @Dom » deux fois,
-- la table n'en garde qu'une ligne.
--
-- Application : psql -h localhost -U alanyavox -d alanya -v ON_ERROR_STOP=1 \
--                    -f prisma/manual/2026-08_message_mention.sql

CREATE TABLE IF NOT EXISTS "message_mention" (
  "idMention" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "idMessage" UUID NOT NULL
    REFERENCES "message"("msgID") ON DELETE CASCADE,
  "userId"    UUID NOT NULL,
  "libelle"   VARCHAR(80) NOT NULL
);

-- La lecture la plus fréquente : les mentions d'un lot de messages qu'on
-- affiche. Sans cet index, chaque ouverture de conversation balaierait la table.
CREATE INDEX IF NOT EXISTS "idx_message_mention_message"
  ON "message_mention" ("idMessage");

-- Celle du destinataire : « ai-je été mentionné ? », pour la notification et
-- pour un futur écran « mes mentions ».
CREATE INDEX IF NOT EXISTS "idx_message_mention_user"
  ON "message_mention" ("userId");

CREATE UNIQUE INDEX IF NOT EXISTS "message_mention_message_user_key"
  ON "message_mention" ("idMessage", "userId");
