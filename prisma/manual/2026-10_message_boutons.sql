-- =============================================================
-- BOUTONS D'ACTION SOUS UN MESSAGE (24/10/2026)
-- =============================================================
-- Le bloc « Boutons » de la bienvenue de la console (comme chez Alanya2026) :
-- `[{ "label", "action": "url" | "route", "target" }]`, déjà dans la langue
-- du destinataire. Posé par le serveur seul. Le message reste un message TEXTE
-- lisible (« Libellé : lien ») : une application pas encore à jour l'affiche
-- tel quel, une application à jour dessine les boutons.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "boutons" JSONB;
