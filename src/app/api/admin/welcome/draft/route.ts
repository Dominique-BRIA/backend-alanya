import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { enregistrerBrouillon } from "@/lib/gestion/bienvenue";

/** PUT /api/admin/welcome/draft — `{ blocks }` : blocs de texte, en français. */
export const PUT = routeAdmin("welcome.draft", async (req) =>
  okAdmin(await enregistrerBrouillon(await req.json().catch(() => null))),
);
