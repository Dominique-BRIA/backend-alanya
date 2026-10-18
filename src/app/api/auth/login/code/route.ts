import { type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { fail, handleError } from "@/lib/http";
import { deviceIdSchema, typeDeviceSchema } from "@/lib/validation";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { verifierDefi } from "@/lib/deux-etapes";
import { terminerConnexion } from "@/modules/auth/terminer-connexion";

const codeSchema = z.object({
  defiId: z.string().uuid("Défi invalide"),
  code: z.string().trim().regex(/^\d{3}\s?\d{3}$/, "Le code compte six chiffres"),
  deviceId: deviceIdSchema,
  typeDevice: typeDeviceSchema,
});

const MESSAGES = {
  DEFI_INCONNU: ["Demande de connexion introuvable, recommencez.", 404],
  DEFI_EXPIRE: ["Ce code a expiré ou a trop servi : reconnectez-vous pour en recevoir un nouveau.", 410],
  DEFI_REFUSE: ["Connexion refusée depuis l'application.", 403],
  CODE_FAUX: ["Code incorrect.", 401],
} as const;

// POST /api/auth/login/code — seconde étape d'une connexion web : le code
// reçu dans l'application. Voir `src/lib/deux-etapes.ts`.
export async function POST(req: NextRequest) {
  try {
    // Plus large que le mot de passe (5/min) : on se trompe plus souvent en
    // recopiant six chiffres. Le défi, lui, n'accepte que cinq essais.
    const rl = await rateLimit(`login-code:${clientIp(req)}`, 10, 60_000);
    if (!rl.allowed) return fail("Trop de tentatives, réessayez plus tard", 429, "RATE_LIMITED");

    const { defiId, code, deviceId, typeDevice } = codeSchema.parse(await req.json());
    const r = await verifierDefi(defiId, code);
    if (!r.ok) {
      const [message, statut] = MESSAGES[r.code];
      const suite = r.restants ? ` Encore ${r.restants} essai${r.restants > 1 ? "s" : ""}.` : "";
      return fail(message + suite, statut, r.code);
    }

    const user = await prisma.user.findUnique({ where: { id: r.userId } });
    if (!user) return fail("Compte introuvable", 404, "NOT_FOUND");
    if (user.exclus === 1) return fail("Votre compte a été suspendu", 403, "EXCLUDED");

    return terminerConnexion(user, req, deviceId, typeDevice);
  } catch (err) {
    return handleError(err);
  }
}
