-- Boutons d'une diffusion (24/10/2026, demande du user) : comme le bloc
-- « Boutons » du message de bienvenue, livrés en message à part juste après
-- celui de la diffusion. Forme : [{ action, target, libelles: {fr, en, zh} }].
-- NULL = pas de bouton (toutes les diffusions existantes).
ALTER TABLE diffusion ADD COLUMN IF NOT EXISTS boutons JSONB;
