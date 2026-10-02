import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { fermerVueUnique } from "@/modules/messaging/vue-unique";

/**
 * POST /api/messages/:id/vue-unique/fermer — le visionneur est refermé.
 *
 * Clôt l'accès de cette personne et efface le fichier si tous les
 * destinataires ont vu. Toujours 200, même sans ouverture : l'application
 * l'appelle en refermant, sans avoir à savoir où en est le serveur.
 *
 * ⚠️ JAMAIS INDISPENSABLE : une application tuée ne l'appellera pas. La
 * fenêtre d'ouverture et la purge périodique prennent alors le relais.
 */
export const POST = withAuth(async (_req, userId, ctx) => {
  const { id } = await ctx.params;
  await fermerVueUnique(id, userId);
  return ok({ ferme: true });
});
