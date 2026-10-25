-- Stickers PERSONNELS (25/10/2026, demande du user : « créer ses stickers
-- comme sur WhatsApp »). Un pack « Mes créations » par compte : il porte son
-- propriétaire, n'apparaît ni au catalogue ni dans la console, et seul son
-- propriétaire peut en envoyer les stickers (un destinataire en garde une
-- COPIE dans son propre pack). NULL = pack officiel de la console.
ALTER TABLE sticker_pack ADD COLUMN IF NOT EXISTS proprietaire_id uuid REFERENCES users("alanyaID") ON DELETE CASCADE;

-- Un seul pack personnel par compte.
CREATE UNIQUE INDEX IF NOT EXISTS sticker_pack_perso_unique ON sticker_pack (proprietaire_id) WHERE proprietaire_id IS NOT NULL;
