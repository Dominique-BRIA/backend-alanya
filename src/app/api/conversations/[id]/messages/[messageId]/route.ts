import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { assertParticipant } from "@/modules/messaging/access";
import { rafraichirApercuApresEdition } from "@/lib/apercu-conversation.mjs";
import { LONGUEUR_MAX_CONTENU } from "@/lib/message-payload.mjs";
import { refusModification } from "@/lib/e2ee-clair.mjs";
import { refusDelaiModification, refusDelaiSuppression } from "@/lib/delais-message.mjs";

// PATCH /api/conversations/:convId/messages/:messageId — modifier un message.
// Repli REST (la diffusion temps réel est gérée par le serveur WS). Seul
// l'expéditeur, uniquement un message TEXTE non supprimé.
export const PATCH = withAuth(
  async (req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id: convId, messageId } = await ctx.params;
    await assertParticipant(convId, userId);

    const corps = await req.json();
    const { content: contenuBrut } = corps;

    /*
     * 🔴 MODIFIER UN MESSAGE CHIFFRÉ (07/10/2026, « modifier le message ne
     * donne plus »).
     *
     * Le serveur n'a pas le texte, il ne peut donc pas le remplacer : le
     * nouveau texte part dans des ENVELOPPES, rattachées à ce message, avec
     * `modifie: true` dans la charge (cours, chapitre 29). Ici, on ne fait que
     * DATER la modification, pour que « modifié » s'affiche partout.
     *
     * ⚠️ AUCUN CONTENU N'EST ACCEPTÉ avec le drapeau, et seulement un message
     * qui n'a PAS de contenu en base : un ancien message écrit en clair avant
     * l'activation reste non modifiable — le modifier exigerait d'effacer son
     * clair, que d'autres ont déjà reçu.
     */
    if (corps?.chiffre === true) {
      if (typeof contenuBrut === "string" && contenuBrut.trim() !== "") {
        return fail("Un message chiffré se modifie sans contenu", 400, "CONTENU_EN_CLAIR");
      }
      const ligne = await prisma.message.findUnique({ where: { id: messageId } });
      if (!ligne || ligne.convId !== convId) return fail("Message introuvable", 404, "NOT_FOUND");
      if (ligne.senderId !== userId) {
        return fail("Seul l'expéditeur peut modifier ce message", 403, "FORBIDDEN");
      }
      if (ligne.deletedAt) return fail("Message supprimé", 400, "DELETED");
      // Deux heures pour modifier — voir `delais-message.mjs`.
      const tropTardChiffre = refusDelaiModification(ligne.createdAt);
      if (tropTardChiffre) {
        return fail("Ce message ne peut plus être modifié (2 heures après l'envoi).", 403, tropTardChiffre);
      }
      if (ligne.type !== "TEXT") {
        return fail("Seuls les messages texte sont modifiables", 400, "NOT_TEXT");
      }
      if ((ligne.content ?? "") !== "") {
        return fail("Ce message n'est pas chiffré", 409, "PAS_CHIFFRE");
      }
      const fil = await prisma.conversation.findUnique({
        where: { id: convId },
        select: { e2eeActif: true },
      });
      if (fil?.e2eeActif !== true) {
        return fail("Cette conversation n'est pas chiffrée", 409, "PAS_CHIFFRE");
      }
      const date = await prisma.message.update({
        where: { id: messageId },
        data: { editedAt: new Date() },
        select: { id: true, editedAt: true },
      });
      return ok({ id: date.id, editedAt: date.editedAt });
    }

    if (typeof contenuBrut !== "string" || !contenuBrut.trim()) {
      return fail("Contenu vide", 400, "EMPTY");
    }
    // Coupé à la longueur de la colonne, comme sur le chemin WebSocket : seul du
    // TEXTE est modifiable (contrôlé plus bas), il n'y a aucune charge JSON à
    // ménager ici. Sans cette coupe, allonger un message au-delà de 500
    // caractères ferait échouer l'UPDATE en 22001.
    const content = contenuBrut.trim().slice(0, LONGUEUR_MAX_CONTENU);

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) return fail("Message introuvable", 404, "NOT_FOUND");
    if (message.senderId !== userId) {
      return fail("Seul l'expéditeur peut modifier ce message", 403, "FORBIDDEN");
    }
    if (message.deletedAt) return fail("Message supprimé", 400, "DELETED");
    // Deux heures pour modifier — voir `delais-message.mjs`.
    const tropTard = refusDelaiModification(message.createdAt);
    if (tropTard) {
      return fail("Ce message ne peut plus être modifié (2 heures après l'envoi).", 403, tropTard);
    }
    if (message.type !== "TEXT") {
      return fail("Seuls les messages texte sont modifiables", 400, "NOT_TEXT");
    }

    /*
     * 🔴 UN FIL CHIFFRÉ NE SE MODIFIE PAS EN CLAIR — même règle que le
     * WebSocket (`handleEditMessage`), écrite une seule fois dans
     * `e2ee-clair.mjs`. Sans elle, le repli REST du mobile écrivait le texte
     * modifié en clair dans `message.content`.
     *
     * ⚠️ LE FIL DU MESSAGE, PAS CELUI DE L'ADRESSE : c'est lui qui est
     * modifié, et les deux ne sont comparés nulle part ci-dessus.
     */
    const fil = await prisma.conversation.findUnique({
      where: { id: message.convId },
      select: { e2eeActif: true },
    });
    const refus = refusModification({ filChiffre: fil?.e2eeActif === true });
    if (refus) {
      return fail(
        "Cette conversation est chiffrée : un message ne peut pas y être modifié.",
        409,
        refus,
      );
    }

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { content, editedAt: new Date() },
    });

    // Même règle que sur le chemin WebSocket, et surtout le même code : la liste
    // des conversations lit un libellé dénormalisé, qu'une modification doit
    // réécrire quand elle porte sur le dernier message. Deux chemins d'édition,
    // une seule règle — les laisser diverger rendrait le défaut intermittent,
    // selon que le WebSocket est debout ou non.
    const lastMessage = await rafraichirApercuApresEdition(
      prisma,
      message,
      content,
    );

    return ok({
      id: updated.id,
      content: updated.content,
      editedAt: updated.editedAt,
      lastMessage,
    });
  },
);

// DELETE /api/conversations/:convId/messages/:messageId?scope=everyone|me
// Repli REST quand le WebSocket n'est pas disponible (la notification temps réel
// est gérée par le serveur WS pour le scope "everyone").
export const DELETE = withAuth(
  async (req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id: convId, messageId } = await ctx.params;
    await assertParticipant(convId, userId);

    const scope = req.nextUrl.searchParams.get("scope") ?? "me";
    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) return fail("Message introuvable", 404, "NOT_FOUND");

    if (scope === "everyone") {
      // Seul l'expéditeur peut supprimer pour tout le monde.
      if (message.senderId !== userId) {
        return fail("Seul l'expéditeur peut supprimer ce message pour tous", 403, "FORBIDDEN");
      }
      // Vingt-quatre heures pour supprimer pour tous — voir `delais-message.mjs`.
      // « Pour moi » reste possible sans délai.
      const tropTard = refusDelaiSuppression(message.createdAt);
      if (tropTard) {
        return fail(
          "Ce message ne peut plus être supprimé pour tout le monde (24 heures après l'envoi).",
          403,
          tropTard,
        );
      }
      // Marque le message comme supprimé : efface le contenu, détache les médias.
      await prisma.message.update({
        where: { id: messageId },
        data: { deletedAt: new Date(), content: null },
      });
      /*
       * 🔴 LES ENVELOPPES PARTENT AUSSI. Vider `content` ne supprime rien d'un
       * message chiffré — il n'en a pas. Ses enveloppes restaient servies, et
       * un destinataire hors ligne déchiffrait plus tard ce que l'auteur avait
       * supprimé pour tous. Prouvé par `scripts/e2ee-depot-banc.mjs` ⑤.
       */
      await prisma.e2eeEnveloppe.deleteMany({ where: { messageId } });
      await prisma.mediaFile.updateMany({
        where: { messageId },
        data: { messageId: null },
      });
      return ok({ deleted: true, scope: "everyone", messageId });
    }

    // scope = "me" : masque le message pour cet utilisateur uniquement.
    await prisma.messageHide.upsert({
      where: { userId_messageId: { userId, messageId } },
      create: { userId, messageId },
      update: {},
    });
    return ok({ deleted: true, scope: "me", messageId });
  },
);
