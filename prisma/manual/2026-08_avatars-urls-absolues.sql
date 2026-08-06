-- ===========================================================================
-- Avatars : les URL passent en ABSOLU dans la base
--
-- Décision du 06/08/2026. C'est l'inverse du principe habituel — on garde
-- d'ordinaire une identité en base et on bâtit l'emplacement à la lecture.
-- Ce qui tranche ici : **la base est PARTAGÉE**. Le backend de l'équipe lit
-- `users.avatar_url` directement, sans passer par notre API. Un chemin
-- relatif n'a de sens que pour qui connaît notre hôte ; il leur était donc
-- inutilisable, et c'est précisément ce qu'ils nous ont signalé.
--
-- Prix à payer, assumé : un changement de domaine devient une migration de
-- données au lieu d'une variable d'environnement. Le jour venu, ce sont ces
-- deux mêmes UPDATE.
--
-- La cible est `/api/avatars/<id>`, PAS `/api/media/<id>` : la première est
-- publique et sans jeton, la seconde sert aussi les pièces jointes privées.
--
-- Les valeurs déjà absolues (`https://api.dicebear.com/...`) et les images
-- `data:` écrites par l'équipe ne sont PAS touchées : le filtre ne retient que
-- notre ancien préfixe.
--
-- Idempotent : après passage, plus aucune ligne ne commence par `/api/media/`,
-- les UPDATE ne trouvent rien. Rejoué à chaque déploiement sans effet.
-- ===========================================================================

BEGIN;

-- `/api/media/` fait 11 caractères : le douzième ouvre l'identifiant.
UPDATE "users"
   SET avatar_url = 'https://alanyavox.com/api/avatars/' || substring(avatar_url from 12)
 WHERE avatar_url LIKE '/api/media/%';

-- Photos de groupe. Colonne `groupPhoto`, pas `avatar_url` : elles vivent
-- dans `conversation` et le champ Prisma `avatarUrl` y est mappé.
UPDATE "conversation"
   SET "groupPhoto" = 'https://alanyavox.com/api/avatars/' || substring("groupPhoto" from 12)
 WHERE "groupPhoto" LIKE '/api/media/%';

COMMIT;
