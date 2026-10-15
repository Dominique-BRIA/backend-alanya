import { routeAdmin } from "@/lib/gestion/session";
import { profilAdmin } from "@/lib/gestion/profil";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";

/** GET /api/admin/me — le profil et les permissions du superroot connecté. */
export const GET = routeAdmin("profile.read", async (_req, session) => okAdmin(profilAdmin(session)));

/**
 * PUT /api/admin/me — refusé.
 *
 * La console permet de modifier nom, pseudo, e-mail et avatar ; un superroot
 * n'a rien de tout cela (la table `Root` ne porte qu'un identifiant et un mot
 * de passe), et son identifiant est partagé avec alanyaCenter. Le changer ici
 * le changerait là-bas : ce n'est pas à cette console de le faire.
 */
export const PUT = routeAdmin("profile.update", async () => {
  throw new ErreurAdmin(400, "Le profil d'un superroot ne se modifie pas ici", "PROFILE_NOT_EDITABLE");
});
