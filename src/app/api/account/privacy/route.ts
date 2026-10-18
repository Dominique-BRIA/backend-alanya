import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { deuxEtapesImposee } from "@/lib/deux-etapes";

const REGLAGES = {
  readReceipts: true,
  lastSeenVisibility: true,
  chiffrementActif: true,
  nomVerrouille: true,
  deuxEtapes: true,
  typeCompte: true,
} as const;

// GET /api/account/privacy — réglages de confidentialité de l'utilisateur.
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: REGLAGES,
  });
  return ok({
    readReceipts: u?.readReceipts ?? 1,
    lastSeenVisibility: u?.lastSeenVisibility ?? 2,
    /*
     * ⚠️ LE DÉFAUT EST `true`, ICI AUSSI. Un compte introuvable ou un serveur
     * plus ancien que la colonne doit laisser le client CHIFFRER, pas se taire :
     * le réglage par défaut protège, et c'est la décision du 12/10/2026.
     */
    chiffrementActif: u?.chiffrementActif ?? true,
    // « Personne ne peut me renommer » (18/10/2026) — voir `User.nomVerrouille`.
    nomVerrouille: u?.nomVerrouille ?? false,
    // Connexion web en deux étapes (18/10/2026) — voir `deux-etapes.ts`.
    // `deuxEtapesImposee` : agent d'entreprise, l'interrupteur est grisé.
    deuxEtapes: u ? u.deuxEtapes || deuxEtapesImposee(u) : false,
    deuxEtapesImposee: u ? deuxEtapesImposee(u) : false,
  });
});

// POST /api/account/privacy — met à jour un ou plusieurs réglages.
// Body { readReceipts?: 0|1, lastSeenVisibility?: 0|1|2,
//        chiffrementActif?: boolean, nomVerrouille?: boolean }.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const body = await req.json();
  const data: {
    readReceipts?: number;
    lastSeenVisibility?: number;
    chiffrementActif?: boolean;
    nomVerrouille?: boolean;
    deuxEtapes?: boolean;
  } = {};

  // Connexion web en deux étapes : au choix, sauf pour un compte qui l'a
  // imposée (l'éteindre n'y change rien, voir `deuxEtapesExigee`).
  if (typeof body?.deuxEtapes === "boolean") {
    data.deuxEtapes = body.deuxEtapes;
  }

  /*
   * ⚠️ LE COUPER N'OUVRE RIEN DE CE QUI EST DÉJÀ FERMÉ : les conversations
   * déjà chiffrées le restent — le chiffrement ne se défait pas. Ce réglage
   * arrête seulement d'en chiffrer de nouvelles, et les clients le disent.
   */
  if (typeof body?.chiffrementActif === "boolean") {
    data.chiffrementActif = body.chiffrementActif;
  }

  /*
   * « Personne ne peut me renommer » : les noms qu'on m'a donnés sont ignorés
   * partout, sans être effacés — rouvrir la possibilité les fait revenir.
   */
  if (typeof body?.nomVerrouille === "boolean") {
    data.nomVerrouille = body.nomVerrouille;
  }

  if (body?.readReceipts === 0 || body?.readReceipts === 1) {
    data.readReceipts = body.readReceipts;
  }
  if ([0, 1, 2].includes(body?.lastSeenVisibility)) {
    data.lastSeenVisibility = body.lastSeenVisibility;
  }
  if (Object.keys(data).length === 0) {
    return fail("Aucun réglage valide fourni", 400, "NO_CHANGES");
  }

  const u = await prisma.user.update({
    where: { id: userId },
    data,
    select: REGLAGES,
  });
  return ok({
    chiffrementActif: u.chiffrementActif,
    readReceipts: u.readReceipts,
    lastSeenVisibility: u.lastSeenVisibility,
    nomVerrouille: u.nomVerrouille,
    deuxEtapes: u.deuxEtapes || deuxEtapesImposee(u),
    deuxEtapesImposee: deuxEtapesImposee(u),
  });
});
