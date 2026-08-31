-- Mettre une conversation en sourdine — colonne `sourdine` sur `conv_participants`.
--
-- L'interrupteur « Mettre en sourdine » EXISTAIT DÉJÀ DANS L'INTERFACE WEB et ne
-- commandait rien : un `useState(false)` local, un message de confirmation
-- « Conversation mise en sourdine », et aucune trace côté serveur — pas une
-- colonne, pas un réglage consulté à l'envoi d'une notification. Le panneau
-- étant démonté à sa fermeture, l'état ne survivait même pas à l'écran.
-- L'utilisateur croyait une conversation muette et continuait d'être notifié.
--
-- PAR PARTICIPANT et non par conversation : une mise en sourdine est un choix
-- personnel. La poser sur la conversation la ferait subir à tout le groupe, ce
-- qui est exactement l'inverse de l'intention.
--
-- Le type suit `isPinned`, `isArchived` et `unreadCount`, déjà sur cette table :
-- un `SMALLINT` à 0/1 plutôt qu'un booléen, pour rester homogène avec elles.
--
-- ⚠️ `ADD COLUMN IF NOT EXISTS` NE VÉRIFIE PAS LE TYPE : si la colonne existe
-- déjà sous une autre forme, l'instruction est sautée en silence et le modèle
-- Prisma ne correspondra plus. Vérifier par `\d conv_participants` en cas de
-- doute.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

ALTER TABLE "conv_participants"
  ADD COLUMN IF NOT EXISTS "sourdine" SMALLINT NOT NULL DEFAULT 0;

-- Les notifications ne sont poussées qu'aux participants HORS LIGNE d'une
-- conversation donnée : la recherche part toujours de `conversID`, et la
-- sourdine ne fait qu'écarter des lignes déjà retenues. Aucun index à ajouter —
-- `conv_participants` en porte déjà un sur `conversID` via sa contrainte
-- d'unicité, et un index sur une colonne à deux valeurs ne servirait à rien.
