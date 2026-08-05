-- Table: conversation_lock
-- Reservation d'une conversation par UN appareil, pour un compte donne.
--
-- Cas d'usage : un numero professionnel partage entre plusieurs agents. Celui
-- qui prend la main sur une discussion la reserve, et les autres appareils du
-- MEME compte ne peuvent plus y ecrire. Le verrou n'isole pas : les autres
-- appareils continuent de tout recevoir en temps reel.
CREATE TABLE "conversation_lock" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversID" UUID NOT NULL,
    "alanyaID" UUID NOT NULL,
    -- Appareil detenteur. Pas de cle etrangere : "Appareil"."idAgent" n'est pas
    -- unique, et le verrou ne doit pas tomber si la ligne d'appareil disparait.
    "appareilID" INTEGER NOT NULL,
    -- Nom affiche du detenteur, fige a la pose : les autres appareils doivent
    -- pouvoir dire QUI a la main sans requeter le registre a chaque affichage.
    "detenteur" VARCHAR(80),
    "locked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Peremption. Le detenteur la repousse tant qu'il est connecte ; a defaut le
    -- verrou tombe seul, sinon une fermeture brutale reserverait a vie.
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "conversation_lock_pkey" PRIMARY KEY ("id")
);

-- Un seul verrou par conversation ET par compte : la main se passe entre les
-- appareils d'un meme compte, pas entre comptes.
CREATE UNIQUE INDEX "conversation_lock_convID_alanyaID_key"
    ON "conversation_lock"("conversID", "alanyaID");

-- « Quelles conversations mon compte a-t-il reservees ? » — sert au filtre.
CREATE INDEX "conversation_lock_alanyaID_idx" ON "conversation_lock"("alanyaID");

-- Purge des verrous perimes.
CREATE INDEX "conversation_lock_expires_at_idx" ON "conversation_lock"("expires_at");

ALTER TABLE "conversation_lock"
    ADD CONSTRAINT "conversation_lock_conversID_fkey"
    FOREIGN KEY ("conversID") REFERENCES "conversation"("conversID")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_lock"
    ADD CONSTRAINT "conversation_lock_alanyaID_fkey"
    FOREIGN KEY ("alanyaID") REFERENCES "users"("alanyaID")
    ON DELETE CASCADE ON UPDATE CASCADE;
