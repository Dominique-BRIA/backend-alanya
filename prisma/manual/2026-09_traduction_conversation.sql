-- LA TRADUCTION, REGLEE PAR PERSONNE ET PAR CONVERSATION.
--
-- 🔴 POURQUOI DANS `conv_participants` ET NON DANS UNE TABLE NEUVE. Cette table
-- EST deja le lieu des preferences d'une personne sur une conversation :
-- `sourdine`, `isPinned`, `isArchived`, `unreadCount` y vivent, sous la meme
-- unicite (conversation, compte). Une table de plus aurait duplique cette cle,
-- ajoute une jointure a chaque lecture, et sepAre en deux endroits des reglages
-- qui se lisent toujours ensemble.
--
-- ⚠️ LES DEUX COLONNES SONT NULLABLES, ET LE NULL PORTE UN SENS PRECIS DANS LES
-- DEUX CAS. Ce n'est pas de la place perdue : c'est le troisieme etat, celui
-- qu'un booleen ne sait pas dire.

-- Langue dans laquelle ECRIT le correspondant, declaree par l'utilisateur.
--
-- NULL = detection automatique, c'est-a-dire le comportement actuel, inchange.
-- Renseignee, elle est passee telle quelle au moteur de traduction et l'etape de
-- detection est entierement court-circuitee : l'application cesse de deviner.
--
-- ⚠️ VARCHAR(10) ET NON VARCHAR(2) : une langue s'ecrit parfois avec sa region
-- (`pt-BR`, `zh-Hans`), et tronquer a deux caracteres confondrait le portugais
-- du Bresil avec celui du Portugal — deux traductions differentes.
ALTER TABLE "conv_participants"
    ADD COLUMN IF NOT EXISTS "langue_source" VARCHAR(10);

COMMENT ON COLUMN "conv_participants"."langue_source" IS
    'Langue declaree du correspondant. NULL = detection automatique.';

-- Traduction automatique de CETTE conversation.
--
-- 🔴 TROIS ETATS, ET LE TROISIEME EST LE PLUS IMPORTANT :
--   NULL = suit le reglage global de l application  (valeur par defaut)
--   0    = desactivee pour cette conversation, meme si le global est actif
--   1    = activee pour cette conversation, meme si le global est inactif
--
-- ⚠️ UN BOOLEEN AURAIT CONFONDU « JAMAIS TOUCHE PAR L UTILISATEUR » ET
-- « DESACTIVE VOLONTAIREMENT ». La difference est tout le sujet : la premiere
-- doit suivre le global quand il change, la seconde doit lui resister. Avec un
-- booleen, activer le global aurait rallume des conversations que quelqu un
-- avait expressement eteintes.
ALTER TABLE "conv_participants"
    ADD COLUMN IF NOT EXISTS "traduction_auto" SMALLINT;

COMMENT ON COLUMN "conv_participants"."traduction_auto" IS
    'Traduction de cette conversation : NULL = suit le global, 0 = jamais, 1 = toujours.';
