import { type NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail, handleError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { rateLimit } from "@/lib/rate-limit";
import { DUREE_DEFI_MS, lancerDefi, verifierDefi } from "@/lib/deux-etapes";
import { prisma } from "@/lib/prisma";

/**
 * LA CONFIRMATION D'IDENTITÉ AVANT DE CRÉER UNE ENSEIGNE (07/11/2026).
 *
 * Décision du user : « Continuer avec Alanya Work » passe par la double
 * authentification déjà en place. C'est le mécanisme de la connexion web
 * (`deux-etapes.ts`) : un code à six chiffres envoyé dans l'application, avec
 * « Ce n'est pas moi », cinq minutes et cinq essais.
 *
 * Un code validé vaut pour 30 minutes (`DUREE_CONFIRMATION_MS`). Un code de
 * connexion web validé juste avant compte aussi : on ne fait pas saisir deux
 * codes d'affilée à quelqu'un qui vient de se connecter avec le sien.
 *
 * POST /api/developer/confirmation  → envoie le code : `{ defiId, expireDans }`
 * PUT  /api/developer/confirmation  → `{ defiId, code }` : le vérifie.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  // Une demande déclenche une notification : on ne la laisse pas répéter.
  const rl = await rateLimit(`dev-confirmation:${userId}`, 5, 60_000);
  if (!rl.allowed) return fail("Trop de demandes de code, réessayez dans une minute.", 429, "RATE_LIMITED");

  const defi = await lancerDefi(userId, req, "enseigne");
  if (!defi.ok) {
    return fail(
      "Aucune application Alanya n'est connectée à ce compte : le code ne peut pas vous parvenir.",
      409,
      "SANS_APPLICATION",
    );
  }
  return ok({ defiId: defi.defiId, expireDans: DUREE_DEFI_MS / 1000 });
});

const codeSchema = z.object({
  defiId: z.string().uuid("Demande invalide"),
  code: z.string().trim().regex(/^\d{3}\s?\d{3}$/, "Le code compte six chiffres"),
});

const MESSAGES = {
  DEFI_INCONNU: ["Demande introuvable, redemandez un code.", 404],
  DEFI_EXPIRE: ["Ce code a expiré ou a trop servi : redemandez-en un.", 410],
  DEFI_REFUSE: ["Refusé depuis l'application.", 403],
  CODE_FAUX: ["Code incorrect.", 401],
} as const;

/** PUT /api/developer/confirmation — `{ defiId, code }` : vérifie le code. */
export const PUT = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const rl = await rateLimit(`dev-confirmation-code:${userId}`, 10, 60_000);
    if (!rl.allowed) return fail("Trop de tentatives, réessayez plus tard.", 429, "RATE_LIMITED");

    const { defiId, code } = codeSchema.parse(await req.json().catch(() => ({})));

    // Le défi doit être celui de CE compte : sans ce contrôle, un code reçu
    // par quelqu'un d'autre validerait la demande d'un tiers.
    const defi = await prisma.defiConnexion.findFirst({
      where: { id: defiId, userId },
      select: { id: true },
    });
    if (!defi) {
      const [message, statut] = MESSAGES.DEFI_INCONNU;
      return fail(message, statut, "DEFI_INCONNU");
    }

    const r = await verifierDefi(defiId, code);
    if (!r.ok) {
      const [message, statut] = MESSAGES[r.code];
      const suite = r.restants ? ` Encore ${r.restants} essai${r.restants > 1 ? "s" : ""}.` : "";
      return fail(message + suite, statut, r.code);
    }
    return ok({ confirme: true });
  } catch (err) {
    return handleError(err);
  }
});
