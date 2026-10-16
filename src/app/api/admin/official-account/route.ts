import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { creerCompteOfficiel, presenterCompteOfficiel, trouverCompteOfficiel } from "@/lib/gestion/compte-officiel";

/** GET /api/admin/official-account — le compte officiel, ou `null`. */
export const GET = routeAdmin("official.read", async () => {
  const compte = await trouverCompteOfficiel();
  return okAdmin(compte ? presenterCompteOfficiel(compte) : null);
});

/** POST /api/admin/official-account — le crée (409 s'il existe déjà). */
export const POST = routeAdmin("official.create", async () => {
  return okAdmin(presenterCompteOfficiel(await creerCompteOfficiel()), 201);
});
