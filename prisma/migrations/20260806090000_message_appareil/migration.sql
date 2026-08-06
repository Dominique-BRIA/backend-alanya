-- Rattache un message a l'APPAREIL qui l'a envoye, en plus du compte.
--
-- Un numero professionnel peut etre partage entre plusieurs agents, chacun sur
-- son appareil. `senderID` dit quel COMPTE a ecrit ; cette colonne dit lequel
-- de ses appareils. C'est ce qui permet d'afficher « qui, dans l'equipe, a
-- repondu a ce message » — et seulement aux appareils du meme compte.
--
-- NULL est la valeur normale pour tout l'historique existant, et pour tout
-- client qui n'envoie pas cette information. Un message sans appareil connu
-- n'affiche simplement aucun pseudo : mieux vaut l'absence qu'une valeur
-- inventee.
--
-- Pas de cle etrangere vers "Appareil" : la ligne d'appareil peut etre
-- supprimee (deconnexion a distance, purge) sans que les messages deja envoyes
-- doivent disparaitre ou bloquer la suppression.
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "appareilID" INTEGER;

-- Sert la lecture d'un fil : on ne cherche l'appareil que pour SES propres
-- messages, jamais pour ceux des autres comptes.
CREATE INDEX IF NOT EXISTS "message_appareilID_idx" ON "message" ("appareilID");
