import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

/**
 * MES CLÉS PUBLIQUES — publication et réapprovisionnement.
 *
 * `GET  /api/e2ee/cles` → ce qu'il me reste en stock, par appareil
 * `PUT  /api/e2ee/cles` → publier ou renouveler le jeu d'un appareil
 *
 * 🔴 TOUT CE QUI TRANSITE ICI EST PUBLIC. Aucune clé privée ne doit atteindre
 * cette route, et aucune ne doit être acceptée si elle y arrivait : un serveur
 * qui détient de quoi déchiffrer n'est plus un serveur de bout en bout. Le
 * contrôle n'est pas fait ici — il ne PEUT pas l'être, une clé privée
 * ressemblant trait pour trait à une clé publique — ce qui est précisément la
 * raison de le répéter à qui écrit le client.
 *
 * ⚠️ LES CLÉS APPARTIENNENT À UN APPAREIL, PAS À UN COMPTE. `deviceId` est donc
 * obligatoire partout, et c'est le CLIENT qui le choisit et le garde : le lier
 * à `appareils.appareilID` ferait perdre l'identité — donc toutes les
 * conversations — au premier vidage de cache, qui recrée cette ligne-là.
 */

/** Combien de pré-clés à usage unique avant de crier famine. */
const SEUIL_REAPPRO = 10;

/** Plafond par publication : de quoi tenir, sans laisser gonfler la table. */
const PREKEYS_MAX = 100;

/** Une chaîne base64 plausible, et bornée. */
function b64Valide(v: unknown, maxi = 1024): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= maxi &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(v)
  );
}

function entier(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 2_147_483_647;
}

export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const identites = await prisma.e2eeIdentite.findMany({
    where: { userId },
    select: {
      deviceId: true,
      registrationId: true,
      cleIdentite: true,
      updatedAt: true,
      _count: { select: { prekeysUniques: { where: { consommeLe: null } } } },
    },
  });

  return ok({
    appareils: identites.map((i) => ({
      deviceId: i.deviceId,
      registrationId: i.registrationId,
      cleIdentite: i.cleIdentite,
      majLe: i.updatedAt,
      prekeysRestantes: i._count.prekeysUniques,
      /*
       * ⚠️ C'EST LE SERVEUR QUI RÉCLAME, PAS LE CLIENT QUI DEVINE. Un client
       * qui déciderait seul du moment de se réapprovisionner se tromperait dès
       * qu'un second appareil consomme le même stock — et un stock vide signifie
       * que PERSONNE ne peut plus ouvrir de conversation avec cet appareil,
       * panne muette s'il en est.
       */
      reapproNecessaire: i._count.prekeysUniques < SEUIL_REAPPRO,
    })),
    seuil: SEUIL_REAPPRO,
  });
});

/**
 * Publie le jeu de clés d'un appareil.
 *
 * Corps :
 * ```json
 * {
 *   "deviceId": 1,
 *   "registrationId": 12345,
 *   "cleIdentite": "<base64>",
 *   "prekeySignee": { "id": 1, "clePublique": "<b64>", "signature": "<b64>" },
 *   "prekeys": [{ "id": 1, "clePublique": "<b64>" }, …]
 * }
 * ```
 *
 * ⚠️ IDEMPOTENTE PAR (COMPTE, APPAREIL) : republier remplace la pré-clé signée
 * et AJOUTE les pré-clés uniques. Un client qui rejoue sa publication après une
 * coupure ne doit pas se retrouver sans stock.
 */
export const PUT = withAuth(async (req: NextRequest, userId: string) => {
  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return fail("Corps JSON invalide", 400, "BAD_JSON");
  }
  const r = (corps ?? {}) as Record<string, unknown>;

  if (!entier(r.deviceId) || !entier(r.registrationId)) {
    return fail("« deviceId » et « registrationId » sont des entiers", 400, "BAD_BODY");
  }
  if (!b64Valide(r.cleIdentite)) {
    return fail("« cleIdentite » doit être du base64", 400, "BAD_BODY");
  }

  const ps = (r.prekeySignee ?? {}) as Record<string, unknown>;
  if (!entier(ps.id) || !b64Valide(ps.clePublique) || !b64Valide(ps.signature)) {
    return fail("« prekeySignee » incomplète", 400, "BAD_BODY");
  }

  const brutes = Array.isArray(r.prekeys) ? r.prekeys : [];
  if (brutes.length > PREKEYS_MAX) {
    return fail(`Pas plus de ${PREKEYS_MAX} pré-clés par publication`, 400, "TOO_MANY");
  }
  const prekeys = brutes.map((b) => {
    const p = (b ?? {}) as Record<string, unknown>;
    return entier(p.id) && b64Valide(p.clePublique)
      ? { prekeyId: p.id as number, clePublique: p.clePublique as string }
      : null;
  });
  if (prekeys.some((p) => p === null)) {
    return fail("Une pré-clé est mal formée", 400, "BAD_BODY");
  }

  /*
   * 🔴 LE CHANGEMENT DE CLÉ D'IDENTITÉ EST UN ÉVÉNEMENT, PAS UNE MISE À JOUR.
   *
   * On l'accepte ici — un appareil réinstallé en génère légitimement une neuve
   * — mais les correspondants DOIVENT le voir : c'est sur cette clé que repose
   * la vérification de sécurité entre deux personnes, et un remplacement
   * silencieux est exactement ce que ferait un serveur qui s'interpose.
   *
   * ⚠️ RIEN N'EN AVERTIT ENCORE PERSONNE. C'est la principale dette de ce
   * premier jet, et elle doit être payée avant toute mise en production.
   */
  const identite = await prisma.e2eeIdentite.upsert({
    where: { userId_deviceId: { userId, deviceId: r.deviceId } },
    create: {
      userId,
      deviceId: r.deviceId,
      registrationId: r.registrationId,
      cleIdentite: r.cleIdentite,
    },
    update: {
      registrationId: r.registrationId,
      cleIdentite: r.cleIdentite,
    },
    select: { id: true },
  });

  await prisma.$transaction([
    /*
     * ⚠️ ON REMPLACE LA PRÉ-CLÉ SIGNÉE SANS EFFACER LES ANCIENNES d'un autre
     * identifiant : un correspondant a pu récupérer le paquet juste avant la
     * rotation et écrire une minute après. Supprimer d'office rendrait ce
     * message-là indéchiffrable, sans que rien ne l'explique.
     */
    prisma.e2eePrekeySignee.upsert({
      where: {
        identiteId_prekeyId: { identiteId: identite.id, prekeyId: ps.id as number },
      },
      create: {
        identiteId: identite.id,
        prekeyId: ps.id as number,
        clePublique: ps.clePublique as string,
        signature: ps.signature as string,
      },
      update: {
        clePublique: ps.clePublique as string,
        signature: ps.signature as string,
      },
    }),
    // `skipDuplicates` : rejouer une publication ne doit pas échouer sur une
    // pré-clé déjà rangée.
    prisma.e2eePrekeyUnique.createMany({
      data: prekeys.map((p) => ({ ...p!, identiteId: identite.id })),
      skipDuplicates: true,
    }),
  ]);

  const restantes = await prisma.e2eePrekeyUnique.count({
    where: { identiteId: identite.id, consommeLe: null },
  });

  return ok({ deviceId: r.deviceId, prekeysRestantes: restantes }, 201);
});
