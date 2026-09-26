-- OÙ VIT CE MÉDIA ? UNE COLONNE POUR LE DIRE.
--
-- 🔴 SANS ELLE, ON NE SAURAIT PLUS LE RELIRE. Un fichier déposé dans le bucket
-- public ne se lit pas comme un fichier du bucket privé : le premier a une
-- adresse fixe, le second demande une signature. L'application doit donc savoir,
-- pour chaque média, dans lequel il se trouve — et le DEVINER à partir du chemin
-- serait une règle de plus à tenir, qui se tromperait le jour où le préfixe
-- change.
--
-- ⚠️ NULL = LE BUCKET PRIVÉ, et c'est ce qui rend cette migration sûre : les
-- six cents médias déjà en place n'ont rien à changer. Ils sont là où ils ont
-- toujours été, et la colonne vide le dit exactement.
--
-- ⚠️ UNE MARQUE, PAS UN NOM DE BUCKET. On écrit « public », pas
-- « profilemedia » : le jour où le bucket est renommé ou déplacé, il n'y a
-- qu'une variable d'environnement à changer, pas six cents lignes en base.

ALTER TABLE "media_files"
    ADD COLUMN IF NOT EXISTS "espace" VARCHAR(16);

COMMENT ON COLUMN "media_files"."espace" IS
    'NULL = bucket privé (défaut). « public » = bucket ouvert des accueils et sonneries.';

-- L'index ne porte que les lignes marquées : elles sont une poignée face aux
-- médias de discussion, et indexer les NULL reviendrait à payer pour une
-- question qui ne les concerne jamais.
CREATE INDEX IF NOT EXISTS "media_files_espace_idx"
    ON "media_files" ("espace")
    WHERE "espace" IS NOT NULL;
