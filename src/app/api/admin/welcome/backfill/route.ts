import { after } from "next/server";
import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { demanderRattrapage, poursuivreRattrapage } from "@/lib/gestion/bienvenue";

/**
 * POST /api/admin/welcome/backfill — envoie la bienvenue publiée, une fois,
 * aux comptes existants qui ne l'ont jamais reçue. Le travail commence juste
 * après la réponse ; la boucle de fond le reprend s'il est interrompu.
 */
export const POST = routeAdmin("welcome.backfill", async (_req, session) => {
  const r = await demanderRattrapage(session);
  if (r.queued) after(() => poursuivreRattrapage().then(() => undefined));
  return okAdmin(r);
});
