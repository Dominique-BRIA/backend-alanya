-- Étend la contrainte de longueur du numéro public de 6 à 8 chiffres.
-- Les anciens numéros à 6 chiffres restent strictement identiques et valides.
ALTER TABLE "users" ALTER COLUMN "publicNumber" TYPE VARCHAR(8);
