-- Session unique par famille d'appareil : garder la RAISON d'une révocation.
--
-- ⚠️ POURQUOI CETTE COLONNE EST NÉCESSAIRE, et pas seulement confortable.
--
-- `rotateRefreshToken` révoque l'ancien jeton à CHAQUE rafraîchissement — c'est
-- la rotation, et elle est normale. Un jeton « révoqué » ne dit donc pas
-- pourquoi il l'est. Sans cette colonne, un client qui réessaie son
-- rafraîchissement après une réponse perdue verrait « votre compte a été ouvert
-- sur un autre appareil » : un message alarmant, et faux.
--
-- Avec elle, seule une révocation posée par l'éviction porte `evicted`, et le
-- message n'est affiché que lorsqu'il est vrai — y compris pour un appareil qui
-- était HORS LIGNE au moment de l'éviction et ne l'apprend qu'à son retour, cas
-- que l'événement temps réel ne couvre pas.
--
-- Additif et nullable : les jetons existants gardent `NULL`, ce qui se lit
-- « révoqué par rotation », leur cas réel.

ALTER TABLE refresh_tokens
    ADD COLUMN IF NOT EXISTS revoked_reason VARCHAR(20);
