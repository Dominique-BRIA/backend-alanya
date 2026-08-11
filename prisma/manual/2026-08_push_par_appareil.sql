-- Rattacher un jeton de notification à L'APPAREIL qui l'a obtenu.
--
-- ⚠️ CE QUI MANQUAIT, ET CE QUE ÇA COÛTAIT.
--
-- `push_devices` ne reliait un jeton FCM qu'à un COMPTE. L'envoi cible donc
-- `userId` et arrose tous les jetons enregistrés, quel que soit l'appareil.
-- Deux conséquences, l'une et l'autre constatées :
--
--  - un téléphone DÉCONNECTÉ continuait de recevoir messages et appels. Le
--    client est censé appeler `DELETE /api/push/register` en partant, mais cet
--    appel exige un jeton d'accès valide : expiré, réseau coupé, ou application
--    tuée en pleine déconnexion, et l'association restait en base pour toujours ;
--
--  - un appareil ÉVINCÉ par une connexion ailleurs ne pouvait pas être ciblé du
--    tout : rien en base ne disait quel jeton lui appartenait.
--
-- Nullable : les lignes existantes n'ont pas d'appareil connu. Elles sont
-- traitées comme « appareil indéterminé » — supprimées avec la famille lors
-- d'une éviction, faute de pouvoir les distinguer, exactement comme les sessions
-- sans `device_id` dans `refresh_tokens`.

ALTER TABLE push_devices
    ADD COLUMN IF NOT EXISTS device_id VARCHAR(255);

-- Sert la seule lecture ajoutée : « quels jetons appartiennent à cet appareil
-- de ce compte ? », faite à chaque déconnexion et à chaque éviction.
CREATE INDEX IF NOT EXISTS push_devices_user_device_idx
    ON push_devices("userId", device_id);
