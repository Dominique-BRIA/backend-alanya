-- =============================================================
-- refresh_tokens : rattacher une session à l'appareil qui l'a obtenue
-- =============================================================
-- Sans ce lien, « Déconnecter cet appareil » ne pouvait rien déconnecter : le
-- serveur savait à quel utilisateur appartenait un jeton, pas depuis quel
-- appareil il avait été émis. Le bouton se contentait de retirer une ligne du
-- registre pendant que la session restait pleinement valide — une fausse
-- assurance, précisément dans le cas où l'on s'en sert.
--
-- La colonne porte le même identifiant que « Appareil.cookies_WebID ».
--
-- NULL pour les sessions ouvertes avant cette évolution : elles restent
-- valides, simplement non révocables individuellement. Elles s'éteindront
-- d'elles-mêmes à l'expiration du jeton de rafraîchissement (7 jours).
--
-- Application : bash scripts/apply-manual-sql.sh

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS device_id VARCHAR(255);

-- Sert la révocation : retrouver les sessions d'un appareil donné pour un
-- utilisateur donné.
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_device_idx"
  ON refresh_tokens("userId", device_id);
