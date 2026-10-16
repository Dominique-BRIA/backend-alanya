import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { purger } from "@/lib/gestion/trajets";

/** POST — `{ scope: "retention" | "all" }` : efface les positions, et rend l'état à jour. */
export const POST = routeAdmin("trips.purge", async (req, session) => {
  const corps = (await req.json().catch(() => ({}))) as { scope?: unknown };
  return okAdmin(await purger(String(corps?.scope ?? "retention"), session));
});
