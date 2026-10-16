import { after } from "next/server";
import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { pagination } from "@/lib/gestion/outils";
import { creerCompte, listerComptes, presenterCompteDetail } from "@/lib/gestion/comptes";
import { envoyerBienvenue } from "@/lib/gestion/bienvenue";

/** GET /api/admin/users — liste filtrée et paginée (mêmes filtres que l'export). */
export const GET = routeAdmin("users.read", async (req) => {
  const p = req.nextUrl.searchParams;
  return okAdmin(await listerComptes(p, pagination(p)));
});

/** POST /api/admin/users — crée un compte ordinaire ou un modérateur, qui reçoit la bienvenue. */
export const POST = routeAdmin("users.create", async (req, session) => {
  const u = await creerCompte(await req.json().catch(() => null));
  session.audit = { cibleType: "users", cibleId: u.id };
  after(() => envoyerBienvenue(u.id).then(() => undefined));
  return okAdmin(presenterCompteDetail(u), 201);
});
