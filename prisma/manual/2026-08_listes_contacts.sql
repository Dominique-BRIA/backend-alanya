-- Copie de `prisma/migrations/20260817090000_listes_contacts/migration.sql`, pour le listes de contacts.
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

-- Tables: contactList, contactListMember
-- Listes de contacts : un regroupement nomme, prive au compte qui l'a cree.
--
-- POURQUOI ces tables. Le repertoire est plat, alors que l'usage reel est
-- categoriel : diffuser un message a plusieurs personnes sans les mettre dans
-- une conversation commune, et reconnaitre a l'oreille qui appelle — la
-- famille, l'equipe d'astreinte. Un groupe de discussion ne repond ni a l'un ni
-- a l'autre : il est partage, visible de tous ses membres, et ne porte pas de
-- sonnerie. Une liste, elle, n'existe que pour son proprietaire ; les membres
-- ignorent qu'ils y figurent.
--
-- POURQUOI la sonnerie est une chaine libre et non une enumeration. Elle vaut
-- SOIT un nom de fichier livre avec le client ("incoming_ring.mp3"), SOIT une
-- URL de media relative ("/api/media/<id>") quand l'utilisateur televerse son
-- propre son. Une enumeration ne couvrirait que le premier cas et il faudrait
-- migrer la base a chaque son ajoute au client — un deploiement de base pour un
-- fichier audio. L'espace de noms des sonneries est deja tenu une seule fois,
-- cote client (src/services/ringtones.ts) ; le redeclarer ici donnerait deux
-- verites a garder d'accord, et c'est la base qui perdrait. Le serveur ne
-- controle donc que la longueur, jamais le contenu.

CREATE TABLE IF NOT EXISTS "contactList" (
    "idContactList" UUID NOT NULL DEFAULT gen_random_uuid(),
    "alanyaID" UUID NOT NULL,
    -- Nom donne par l'utilisateur. C'est l'identite visible de la liste.
    "libelle" VARCHAR(80) NOT NULL,
    -- Nom de fichier ou URL de media relative. Voir l'en-tete.
    "ringtone" VARCHAR(300),
    -- Pastille de couleur telle que le client l'ecrit ("#FF7A00"). Non validee :
    -- la palette appartient au client, comme les sonneries.
    "color" VARCHAR(20),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contactList_pkey" PRIMARY KEY ("idContactList")
);

CREATE TABLE IF NOT EXISTS "contactListMember" (
    "idContactListMember" UUID NOT NULL DEFAULT gen_random_uuid(),
    "idContactList" UUID NOT NULL,
    -- Le membre designe un COMPTE et non une ligne de "preferredContact" :
    -- retirer puis re-ajouter la personne a son repertoire ne doit pas vider les
    -- listes ou elle figure.
    "idFriend" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contactListMember_pkey" PRIMARY KEY ("idContactListMember")
);

-- Deux listes homonymes chez le meme compte seraient indiscernables a l'ecran ;
-- le nom est donc unique par proprietaire, pas globalement.
CREATE UNIQUE INDEX IF NOT EXISTS "contactList_alanyaID_libelle_key"
    ON "contactList"("alanyaID", "libelle");

-- « Quelles sont mes listes ? » — la seule lecture de depart.
CREATE INDEX IF NOT EXISTS "contactList_alanyaID_idx" ON "contactList"("alanyaID");

-- L'appartenance est un ensemble : la meme personne ne compte qu'une fois dans
-- une liste, sinon un remplacement de membres pourrait la dupliquer.
CREATE UNIQUE INDEX IF NOT EXISTS "contactListMember_idContactList_idFriend_key"
    ON "contactListMember"("idContactList", "idFriend");

CREATE INDEX IF NOT EXISTS "contactListMember_idContactList_idx"
    ON "contactListMember"("idContactList");

-- Les cles etrangeres sont posees sous garde : PostgreSQL n'a pas d'ADD
-- CONSTRAINT IF NOT EXISTS, et une relance de ce fichier sur une base ou les
-- tables existent deja doit rester sans effet plutot que d'echouer a mi-course.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contactList_alanyaID_fkey') THEN
        ALTER TABLE "contactList"
            ADD CONSTRAINT "contactList_alanyaID_fkey"
            FOREIGN KEY ("alanyaID") REFERENCES "users"("alanyaID")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    -- Le compte parti, ses listes n'ont plus de lecteur : elles s'en vont avec.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contactListMember_idContactList_fkey') THEN
        ALTER TABLE "contactListMember"
            ADD CONSTRAINT "contactListMember_idContactList_fkey"
            FOREIGN KEY ("idContactList") REFERENCES "contactList"("idContactList")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    -- Un compte supprime disparait des listes qui le citaient, sans laisser de
    -- membre fantome que le client afficherait sans nom.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contactListMember_idFriend_fkey') THEN
        ALTER TABLE "contactListMember"
            ADD CONSTRAINT "contactListMember_idFriend_fkey"
            FOREIGN KEY ("idFriend") REFERENCES "users"("alanyaID")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;
