import crypto from "crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { enseigneDuProprietaire } from "@/lib/developer/enseignes";
import { verifierUrlWebhook } from "@/lib/developer/url-webhook";

/**
 * LE WEBHOOK D'UNE ENSEIGNE (07/11/2026).
 *
 * 🔴 LE SECRET SE RÉAFFICHE (décision du user, 07/11/2026). Il n'était rendu
 * qu'une fois, et la console ne le montrait même pas : personne ne pouvait
 * vérifier la signature que le guide exige. Comme chez Stripe, il est
 * désormais lisible dans la console à tout moment — il est de toute façon
 * gardé lisible, puisqu'il faut signer avec — et « Changer le secret » en
 * tire un nouveau.
 *
 * 🔴 L'ADRESSE EST CONTRÔLÉE (`url-webhook.ts`) : https seulement, et aucune
 * adresse de réseau privé, sinon notre serveur deviendrait un relais vers
 * notre propre réseau.
 *
 * Le champ « Verify Token » a disparu : le serveur ne s'en servait jamais.
 */

const SELECTION_WEBHOOK = {
  url: true,
  secretKey: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

function nouveauSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString("hex")}`;
}

// GET /api/developer/webhooks?enseigne=<id>
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const enseigne = await enseigneDuProprietaire(userId, req.nextUrl.searchParams.get("enseigne"));
    const webhook = await prisma.developerWebhook.findUnique({
      where: { developerId: enseigne.id },
      select: SELECTION_WEBHOOK,
    });
    return ok({ webhook });
  } catch (err) {
    return handleError(err);
  }
});

const enregistrementSchema = z.object({
  enseigneId: z.string().uuid(),
  url: z.string().trim().min(1, "L'adresse est requise").max(500),
  actif: z.boolean().optional(),
  /** `true` : tire un nouveau secret. L'ancien cesse aussitôt de valoir. */
  changerSecret: z.boolean().optional(),
});

/**
 * POST /api/developer/webhooks — `{ enseigneId, url, actif?, changerSecret? }`.
 *
 * Le secret est tiré par nous à la première configuration, puis CONSERVÉ :
 * changer seulement l'adresse ne doit pas casser un récepteur en service. Il
 * ne change que sur demande (`changerSecret`).
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const corps = enregistrementSchema.parse(await req.json().catch(() => ({})));
    const enseigne = await enseigneDuProprietaire(userId, corps.enseigneId);

    const verdict = await verifierUrlWebhook(corps.url);
    if (!verdict.ok) return fail(verdict.message, 422, "WEBHOOK_URL_REFUSEE");

    const existant = await prisma.developerWebhook.findUnique({
      where: { developerId: enseigne.id },
      select: { secretKey: true },
    });
    const secretKey =
      corps.changerSecret || !existant?.secretKey ? nouveauSecret() : existant.secretKey;

    const webhook = await prisma.developerWebhook.upsert({
      where: { developerId: enseigne.id },
      create: {
        developerId: enseigne.id,
        url: verdict.url.toString(),
        secretKey,
        isActive: corps.actif ?? true,
      },
      update: {
        url: verdict.url.toString(),
        secretKey,
        isActive: corps.actif ?? true,
      },
      select: SELECTION_WEBHOOK,
    });

    return ok({ webhook });
  } catch (err) {
    return handleError(err);
  }
});

const suppressionSchema = z.object({ enseigneId: z.string().uuid() });

// DELETE /api/developer/webhooks — `{ enseigneId }` : plus aucun envoi.
export const DELETE = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const corps = suppressionSchema.parse(await req.json().catch(() => ({})));
    const enseigne = await enseigneDuProprietaire(userId, corps.enseigneId);
    await prisma.developerWebhook.deleteMany({ where: { developerId: enseigne.id } });
    return ok({ webhook: null });
  } catch (err) {
    return handleError(err);
  }
});
