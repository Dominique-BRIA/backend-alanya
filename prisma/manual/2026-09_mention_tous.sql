-- MENTIONNER TOUT LE GROUPE — « @all », « @tous », selon la langue.
--
-- ⚠️ POURQUOI PAS UNE LIGNE PAR MEMBRE dans `message_mention`, qui existe déjà :
--
--  1. La colonne `userId` y est NOT NULL et référence un compte. Une mention
--     collective ne vise personne en particulier ; il n'y a pas d'identifiant à
--     y mettre.
--  2. Surtout, ce serait FAUX DANS LE TEMPS. Un groupe de trente donnerait
--     trente lignes figées au moment de l'envoi — et quelqu'un qui rejoint le
--     lendemain ne serait pas mentionné, alors que le message dit « tout le
--     monde ». La vérité n'est pas la liste des membres d'alors, c'est
--     l'intention « tous », qui se résout à la lecture.
--
-- Deux colonnes sur le message, donc. Une seule écriture, aucune jointure, et le
-- sens reste juste quelle que soit l'évolution du groupe.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

ALTER TABLE "message"
  ADD COLUMN IF NOT EXISTS "mentionne_tous" BOOLEAN NOT NULL DEFAULT false;

-- LE TEXTE EXACT QUI A ÉTÉ TAPÉ, sans le « @ ».
--
-- Indispensable à l'AFFICHAGE : le client met la mention en évidence en
-- cherchant ce libellé dans le texte. L'application parle neuf langues et
-- l'auteur a pu écrire « all », « tous », « alle »… Le déduire à la lecture
-- demanderait de connaître les neuf formes, et de deviner celle de l'auteur —
-- qui n'est pas forcément celle du lecteur.
--
-- Même longueur que `message_mention.libelle`, pour la même raison.
ALTER TABLE "message"
  ADD COLUMN IF NOT EXISTS "mention_tous_libelle" VARCHAR(80);

COMMENT ON COLUMN "message"."mentionne_tous" IS
  'Le message mentionne TOUT le groupe. Se résout à la lecture, jamais figé en lignes.';
COMMENT ON COLUMN "message"."mention_tous_libelle" IS
  'Le texte tapé après le @, sans le @. Sert à surligner la mention à l''affichage.';
