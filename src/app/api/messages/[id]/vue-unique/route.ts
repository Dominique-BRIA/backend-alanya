import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { ouvrirVueUnique } from "@/modules/messaging/vue-unique";

/**
 * POST /api/messages/:id/vue-unique — OUVRIR un message à vue unique.
 *
 * Écrit l'ouverture (une seule par destinataire), prévient l'expéditeur, et
 * rend le média à charger. La route des médias ne le servira à cette personne
 * que pendant la fenêtre annoncée (`fenetreSecondes`).
 *
 * ⚠️ UN POST ET NON UN GET : ouvrir CONSOMME. Un GET peut être rejoué par un
 * préchargeur, un cache ou un aperçu de lien — et chaque rejeu brûlerait la
 * seule vue de la personne sans qu'elle ait rien vu.
 *
 * Réponses : 200 { media, fenetreSecondes } ; 403 EXPEDITEUR (on ne rouvre pas
 * son propre envoi) ; 404 INTROUVABLE ; 410 DEJA_OUVERTE ou EFFACEE.
 */
export const POST = withAuth(async (_req, userId, ctx) => {
  const { id } = await ctx.params;
  const r = await ouvrirVueUnique(id, userId);
  if (r.ok) return ok({ media: r.media, fenetreSecondes: r.fenetreSecondes });
  switch (r.code) {
    case "EXPEDITEUR":
      return fail("L'expéditeur ne peut pas rouvrir un message à vue unique", 403, r.code);
    case "DEJA_OUVERTE":
      return fail("Ce message à vue unique a déjà été ouvert", 410, r.code);
    case "EFFACEE":
      return fail("Ce média a été effacé", 410, r.code);
    default:
      return fail("Message introuvable", 404, "INTROUVABLE");
  }
});
