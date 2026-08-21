-- Copie de `prisma/migrations/20260819100000_catalogue_sonneries/migration.sql`, pour le catalogue de sonneries.
--
-- 🔴 POURQUOI CE DOUBLON EXISTE, ET POURQUOI IL N'EN EST PAS UN.
--
-- `prisma/migrations/` N'EST JAMAIS JOUE sur cette base : le deploiement
-- n'execute que `scripts/apply-manual-sql.sh`, qui rejoue `prisma/manual/*.sql`.
-- `prisma migrate deploy` est par ailleurs inutilisable ici — l'historique
-- contient une migration en echec (P3009) dont le dossier n'existe plus.
--
-- Une migration deposee seulement dans `prisma/migrations/` passe donc
-- silencieusement a la trappe : le modele Prisma declare les tables, la base ne
-- les a pas, et les routes concernees echouent a l'execution. C'est le mecanisme
-- exact des trois pannes de production de 2026 — `pays.iso2`,
-- `GET /api/conversations`, puis `meeting.invitation_auto`.
--
-- Verifie avant cette copie : les trois tables etaient ABSENTES de la base.
-- Le fichier d'origine est conserve pour un futur `migrate` ; c'est CELUI-CI
-- qui est execute.
--
-- Contenu inchange : les migrations etaient deja idempotentes (`IF NOT EXISTS`
-- partout, cles etrangeres sous garde `pg_constraint`). Seul l'emplacement
-- posait probleme.

-- Table: userRingtone
-- Catalogue des sonneries importees, propre a chaque compte.
--
-- POURQUOI cette table. Le FICHIER suivait deja le compte : importRingtone()
-- (client, src/services/ringtones.ts) le televerse par POST /api/media et n'en
-- garde que l'URL "/api/media/<id>", donc une ligne de "media_files" rattachee
-- au proprietaire. Ce qui ne suivait pas, c'est le CATALOGUE — la liste de ce
-- qu'on a importe — tenu en localStorage sous "alanya-ringtones-custom-v1",
-- c'est-a-dire dans un seul navigateur, sur un seul appareil.
--
-- Le defaut que cela produisait, constate : on importe une sonnerie sur
-- l'ordinateur et on l'attribue a la liste « Clients ». Sur le telephone,
-- « Clients » SONNE correctement, parce que la reference est en base, portee par
-- "contactList"."ringtone". Mais pour donner la MEME sonnerie a une seconde
-- liste depuis le telephone, elle n'apparait pas dans le choix : le catalogue
-- local du telephone ne la connait pas. Il faudrait la reimporter, et le serveur
-- se retrouverait avec deux medias pour un seul son.
--
-- CE QUI RESTE HORS DE LA BASE, deliberatement. Le CHOIX de sonnerie pour les
-- evenements globaux (appel entrant, appel sortant, message), garde dans
-- "alanya-ringtone-incoming" / "-outgoing" / "-message", demeure une PREFERENCE
-- D'APPAREIL, comme le theme ou le volume : on peut vouloir une sonnerie
-- discrete au bureau et forte sur son telephone. Seul le catalogue devient
-- commun au compte.
--
-- POURQUOI PAS de cle etrangere vers "media_files". La colonne "url" est une
-- chaine, comme "contactList"."ringtone" — et c'est exactement la meme valeur
-- qui circule entre les deux, ce qui permet de comparer une entree de catalogue
-- a la sonnerie d'une liste sans rien recomposer. Une FK trancherait ici une
-- question que "contactList"."ringtone" laisse ouverte de son cote : que devient
-- la reference quand le media est supprime ? Aujourd'hui la liste garde son
-- "ringtone" et le client retombe sur la sonnerie par defaut. Le catalogue se
-- comporte donc pareil : il PEUT citer un media disparu, GET /api/media/<id>
-- repond alors 404, et le client ecarte l'entree a la lecture. Aucun nettoyage
-- automatique n'est fait ici — un DELETE en cascade depuis "media_files"
-- ferait disparaitre l'entree de catalogue sans toucher au "ringtone" des
-- listes, qui resterait, lui, mort et invisible : deux comportements pour une
-- meme reference. Mieux vaut un seul, meme imparfait.

CREATE TABLE IF NOT EXISTS "userRingtone" (
    "idUserRingtone" UUID NOT NULL DEFAULT gen_random_uuid(),
    "alanyaID" UUID NOT NULL,
    -- URL relative d'un media deja televerse ("/api/media/<id>"). VARCHAR(300)
    -- comme "contactList"."ringtone" : la meme valeur passe d'une colonne a
    -- l'autre, une borne plus etroite ici refuserait ce que la liste accepte.
    "url" VARCHAR(300) NOT NULL,
    -- Nom montre dans le choix de sonnerie, en general celui du fichier importe.
    -- Coupe a 80 caracteres cote serveur plutot que refuse.
    "label" VARCHAR(80) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "userRingtone_pkey" PRIMARY KEY ("idUserRingtone")
);

-- Le catalogue est un ENSEMBLE de medias, pas un journal d'imports : reimporter
-- le meme fichier doit renommer la ligne existante, pas en ajouter une seconde,
-- sinon le choix de sonnerie afficherait deux fois le meme son.
CREATE UNIQUE INDEX IF NOT EXISTS "userRingtone_alanyaID_url_key"
    ON "userRingtone"("alanyaID", "url");

-- « Quelles sonneries ai-je importees ? » — la seule lecture de depart.
CREATE INDEX IF NOT EXISTS "userRingtone_alanyaID_idx" ON "userRingtone"("alanyaID");

-- La cle etrangere est posee sous garde : PostgreSQL n'a pas d'ADD CONSTRAINT
-- IF NOT EXISTS, et une relance de ce fichier sur une base ou la table existe
-- deja doit rester sans effet plutot que d'echouer a mi-course.
DO $$
BEGIN
    -- Le compte parti, son catalogue n'a plus de lecteur : il s'en va avec. Les
    -- medias eux-memes partent de leur cote, par la cascade de "media_files".
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'userRingtone_alanyaID_fkey') THEN
        ALTER TABLE "userRingtone"
            ADD CONSTRAINT "userRingtone_alanyaID_fkey"
            FOREIGN KEY ("alanyaID") REFERENCES "users"("alanyaID")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;
