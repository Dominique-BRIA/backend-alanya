import { type NextRequest } from "next/server";
import { z } from "zod";
import { clientIp, plafondAtteint, rateLimit } from "@/lib/rate-limit";
import { connecter, emettreJetons } from "@/lib/gestion/session";
import { profilDeSession } from "@/lib/gestion/profil";
import { erreurAdmin, okAdmin, reponseErreurAdmin } from "@/lib/gestion/reponses";

/**
 * POST /api/admin/auth/login — connexion d'un administrateur à la console.
 *
 * Corps : `{ email, password }`, comme chez Alanya2026. `email` porte
 * l'adresse e-mail OU le numéro Alanya du compte (ajout du user, 24/10/2026) ;
 * `username` et `identifiant` sont acceptés comme synonymes.
 *
 * Réponse : `{ accessToken, refreshToken, user }`, la forme de la console.
 */
const corpsSchema = z
  .object({
    username: z.string().trim().min(1).max(100).optional(),
    identifiant: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().min(1).max(100).optional(),
    password: z.string().min(1).max(200),
  })
  .refine((c) => c.username || c.identifiant || c.email, { message: "Identifiant requis" });

const FENETRE_MS = 15 * 60 * 1000;
const ECHECS_MAX = 10;

export async function POST(req: NextRequest) {
  try {
    const corps = corpsSchema.safeParse(await req.json().catch(() => null));
    if (!corps.success) return erreurAdmin(400, "Identifiant et mot de passe requis", "CREDENTIALS_REQUIRED");
    const identifiant = (corps.data.email ?? corps.data.identifiant ?? corps.data.username)!;

    // Deux compteurs d'ÉCHECS : par adresse (un attaquant qui essaie tous les
    // comptes) et par identifiant (un attaquant qui change d'adresse). Le
    // second protège un compte précis quand l'adresse change.
    // Les réussites ne comptent pas : plusieurs administrateurs derrière une
    // même adresse ne doivent pas se bloquer entre eux.
    const cleIp = `gestion-login:ip:${clientIp(req)}`;
    const cleCompte = `gestion-login:id:${identifiant.toLowerCase()}`;
    if ((await plafondAtteint(cleIp, ECHECS_MAX)) || (await plafondAtteint(cleCompte, ECHECS_MAX))) {
      return erreurAdmin(429, "Trop de tentatives, réessayez plus tard", "RATE_LIMITED");
    }

    let session;
    try {
      session = await connecter(identifiant, corps.data.password);
    } catch (e) {
      await rateLimit(cleIp, ECHECS_MAX, FENETRE_MS);
      await rateLimit(cleCompte, ECHECS_MAX, FENETRE_MS);
      throw e;
    }
    const jetons = await emettreJetons(session);
    return okAdmin({ ...jetons, user: await profilDeSession(session) });
  } catch (err) {
    return reponseErreurAdmin(err);
  }
}
