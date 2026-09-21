import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

/**
 * LES ENVELOPPES CHIFFRÉES — le transport, et rien d'autre.
 *
 * `POST   /api/e2ee/enveloppes` → déposer les chiffrés d'un message
 * `GET    /api/e2ee/enveloppes?deviceId=N` → relever ce qui m'attend
 * `DELETE /api/e2ee/enveloppes?ids=a,b,c` → accuser réception
 *
 * 🔴 LE SERVEUR NE LIT RIEN, ET NE PEUT RIEN LIRE. `corps` est une chaîne
 * opaque. Aucune route de ce fichier ne l'inspecte, ne le transforme, ni ne le
 * journalise — et c'est une règle, pas une économie : un journal qui recopie
 * un chiffré ne révèle rien aujourd'hui, mais fait exister un second endroit à
 * protéger, que personne ne surveille.
 *
 * ⚠️ UNE ENVELOPPE PAR APPAREIL DESTINATAIRE. C'est l'expéditeur qui chiffre
 * autant de fois qu'il y a d'appareils, après avoir récupéré un paquet de
 * pré-clés pour chacun. Le serveur ne duplique JAMAIS une enveloppe : il n'en
 * aurait pas les moyens, chaque chiffré étant lié à une session distincte.
 */

/** Plafond d'un dépôt : quelques appareils, pas une diffusion. */
const ENVELOPPES_MAX = 40;

/** Plafond d'une relève, pour borner la réponse. */
const RELEVE_MAX = 200;

/** Taille maximale d'un chiffré, en caractères base64 (~48 Ko utiles). */
const CORPS_MAX = 64 * 1024;

export const POST = withAuth(async (req: NextRequest, userId: string) => {
  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return fail("Corps JSON invalide", 400, "BAD_JSON");
  }
  const r = (corps ?? {}) as { convId?: unknown; deviceId?: unknown; enveloppes?: unknown };

  if (typeof r.convId !== "string" || r.convId === "") {
    return fail("« convId » est requis", 400, "BAD_BODY");
  }
  if (typeof r.deviceId !== "number" || !Number.isInteger(r.deviceId)) {
    return fail("« deviceId » de l'expéditeur est requis", 400, "BAD_BODY");
  }

  /*
   * ⚠️ L'APPARTENANCE À LA CONVERSATION EST VÉRIFIÉE ICI, et c'est le seul
   * contrôle que le serveur puisse encore exercer. Il ne sait plus ce qui est
   * écrit ; il sait encore QUI a le droit d'écrire à QUI, et cette garde-là ne
   * doit pas disparaître avec le chiffrement.
   */
  const moi = await prisma.participant.findFirst({
    where: { convId: r.convId, userId },
    select: { id: true },
  });
  if (!moi) return fail("Conversation inconnue", 404, "NOT_FOUND");

  const brutes = Array.isArray(r.enveloppes) ? r.enveloppes : [];
  if (brutes.length === 0) return fail("Aucune enveloppe", 400, "BAD_BODY");
  if (brutes.length > ENVELOPPES_MAX) {
    return fail(`Pas plus de ${ENVELOPPES_MAX} enveloppes par envoi`, 400, "TOO_MANY");
  }

  const lues = brutes.map((b) => {
    const e = (b ?? {}) as Record<string, unknown>;
    const ok =
      typeof e.destinataireId === "string" &&
      e.destinataireId !== "" &&
      typeof e.destinataireDevice === "number" &&
      Number.isInteger(e.destinataireDevice) &&
      // 1 = PreKeyWhisperMessage, 3 = WhisperMessage. Les deux seules valeurs
      // que la bibliothèque du client sait produire et relire.
      (e.type === 1 || e.type === 3) &&
      typeof e.corps === "string" &&
      e.corps.length > 0 &&
      e.corps.length <= CORPS_MAX;
    return ok
      ? {
          destinataireId: e.destinataireId as string,
          destinataireDevice: e.destinataireDevice as number,
          type: e.type as number,
          corps: e.corps as string,
        }
      : null;
  });
  if (lues.some((e) => e === null)) {
    return fail("Une enveloppe est mal formée", 400, "BAD_BODY");
  }

  // Les destinataires doivent être de la conversation : sans ce contrôle, on
  // s'en servirait pour déposer chez n'importe qui.
  const membres = await prisma.participant.findMany({
    where: { convId: r.convId },
    select: { userId: true },
  });
  const autorises = new Set(membres.map((m) => m.userId));
  if (lues.some((e) => !autorises.has(e!.destinataireId))) {
    return fail("Destinataire hors de la conversation", 403, "FORBIDDEN");
  }

  await prisma.e2eeEnveloppe.createMany({
    data: lues.map((e) => ({
      convId: r.convId as string,
      expediteurId: userId,
      expediteurDevice: r.deviceId as number,
      destinataireId: e!.destinataireId,
      destinataireDevice: e!.destinataireDevice,
      type: e!.type,
      corps: e!.corps,
    })),
  });

  return ok({ deposees: lues.length }, 201);
});

export const GET = withAuth(async (req: NextRequest, userId: string) => {
  const brut = req.nextUrl.searchParams.get("deviceId");
  const deviceId = Number(brut);
  if (brut === null || !Number.isInteger(deviceId)) {
    return fail("« deviceId » est requis", 400, "BAD_BODY");
  }

  /*
   * ⚠️ ON NE MARQUE PAS « REMIS » ICI. Le client peut perdre la réponse, ou
   * planter en plein déchiffrement ; marquer à l'envoi perdrait le message
   * définitivement, puisque personne d'autre ne l'a. C'est l'accusé de
   * réception explicite (`DELETE`) qui retire — le client garde donc la
   * responsabilité de dire qu'il a bien rangé ce qu'il a lu.
   */
  const enveloppes = await prisma.e2eeEnveloppe.findMany({
    where: { destinataireId: userId, destinataireDevice: deviceId, remisLe: null },
    orderBy: { createdAt: "asc" },
    take: RELEVE_MAX,
    select: {
      id: true,
      convId: true,
      expediteurId: true,
      expediteurDevice: true,
      type: true,
      corps: true,
      createdAt: true,
    },
  });

  return ok({ enveloppes });
});

export const DELETE = withAuth(async (req: NextRequest, userId: string) => {
  const brut = req.nextUrl.searchParams.get("ids");
  if (!brut) return fail("« ids » est requis", 400, "BAD_BODY");

  const ids = brut.split(",").map((s) => s.trim()).filter(Boolean).slice(0, RELEVE_MAX);
  if (ids.length === 0) return fail("Aucun identifiant", 400, "BAD_BODY");

  /*
   * ⚠️ LE DESTINATAIRE EST DANS LA CONDITION, jamais seulement l'identifiant :
   * sans lui, un identifiant qui fuite suffirait à faire disparaître le message
   * de quelqu'un d'autre avant qu'il ne l'ait lu.
   */
  const { count } = await prisma.e2eeEnveloppe.updateMany({
    where: { id: { in: ids }, destinataireId: userId, remisLe: null },
    data: { remisLe: new Date() },
  });

  return ok({ acquittees: count });
});
