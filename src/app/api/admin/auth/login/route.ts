import { type NextRequest } from "next/server";
import { z } from "zod";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { connecter, emettreJetons } from "@/lib/gestion/session";
import { profilAdmin } from "@/lib/gestion/profil";
import { erreurAdmin, okAdmin, reponseErreurAdmin } from "@/lib/gestion/reponses";

/**
 * POST /api/admin/auth/login — connexion du superroot à la console de gestion.
 *
 * Corps : `{ username, password }`. La console d'origine envoie `email` (ses
 * admins étaient des utilisateurs) : le champ est accepté comme synonyme, pour
 * qu'elle se connecte avant même d'avoir été retouchée.
 *
 * Réponse : `{ accessToken, refreshToken, user }`, la forme de la console.
 */
const corpsSchema = z
  .object({
    username: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().min(1).max(100).optional(),
    password: z.string().min(1).max(200),
  })
  .refine((c) => c.username || c.email, { message: "Identifiant requis" });

const FENETRE_MS = 15 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const corps = corpsSchema.safeParse(await req.json().catch(() => null));
    if (!corps.success) return erreurAdmin(400, "Identifiant et mot de passe requis", "CREDENTIALS_REQUIRED");
    const identifiant = (corps.data.username ?? corps.data.email)!;

    // Deux compteurs : par adresse (un attaquant qui essaie tous les comptes)
    // et par identifiant (un attaquant qui change d'adresse). Le second est le
    // seul à protéger le compte maître, unique et connu de nom.
    const parIp = await rateLimit(`gestion-login:ip:${clientIp(req)}`, 10, FENETRE_MS);
    const parCompte = await rateLimit(`gestion-login:id:${identifiant.toLowerCase()}`, 10, FENETRE_MS);
    if (!parIp.allowed || !parCompte.allowed) {
      return erreurAdmin(429, "Trop de tentatives, réessayez plus tard", "RATE_LIMITED");
    }

    const session = await connecter(identifiant, corps.data.password);
    const jetons = await emettreJetons(session);
    return okAdmin({ ...jetons, user: profilAdmin(session) });
  } catch (err) {
    return reponseErreurAdmin(err);
  }
}
