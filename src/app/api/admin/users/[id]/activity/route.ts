import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { idUuid } from "@/lib/gestion/outils";
import { activiteCompte, compteRequis } from "@/lib/gestion/comptes";

export const GET = routeAdmin("users.read", async (_req, _s, ctx: { params: Promise<{ id: string }> }) => {
  const id = idUuid((await ctx.params).id, "USER_NOT_FOUND");
  await compteRequis(id);
  return okAdmin(await activiteCompte(id));
});
