import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { isGroupAdmin } from "@/lib/groups";

/**
 * LES BOÎTES PERMANENTES DES GROUPES CHIFFRÉS — cours, chapitre 39.
 *
 * `PUT /api/e2ee/boites` → déposer (ou remplacer) des boîtes
 *   corps : { convId, deviceId, boites: [{ destinataireId, destinataireDevice, corps }] }
 * `GET /api/e2ee/boites?deviceId=N[&convId=…]` → relire MES boîtes, pour cet appareil
 *
 * 🔴 POURQUOI ELLES EXISTENT (décision du user, 10/10/2026 : « pas besoin
 * qu'un admin soit connecté pour qu'il ait les clés »). Le trousseau voyageait
 * seulement dans des enveloppes Signal À USAGE UNIQUE ; un appareil qui la
 * ratait devait attendre qu'un administrateur la renvoie. La boîte, elle,
 * RESTE : l'appareil la relit quand il veut, sans personne en ligne.
 *
 * 🔴 LE SERVEUR NE PEUT PAS L'OUVRIR : elle est scellée avec la clé d'identité
 * de l'appareil destinataire, et signée par l'appareil qui l'a déposée. Le
 * destinataire vérifie la signature (avec une identité qu'il connaît déjà) et
 * que l'expéditeur administre le groupe — mêmes règles que pour une enveloppe.
 *
 * ⚠️ QUI PEUT DÉPOSER : un ADMINISTRATEUR du groupe, pour n'importe quel membre
 * actif ; un simple membre, pour SES PROPRES appareils seulement. Le serveur le
 * vérifie aussi, pour ne pas laisser n'importe qui remplacer la boîte d'un
 * autre (le destinataire refuserait le contenu, mais aurait perdu la bonne).
 */

/** Taille maximale d'une boîte, en caractères — la même que la contrainte SQL. */
const CORPS_MAX = 20_000_000;

/** Boîtes par dépôt : quelques centaines d'appareils, comme les enveloppes. */
const BOITES_MAX = 1000;

const entier = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

export const PUT = withAuth(async (req: NextRequest, userId: string) => {
  let brut: unknown;
  try {
    brut = await req.json();
  } catch {
    return fail("Corps JSON invalide", 400, "BAD_JSON");
  }
  const r = (brut ?? {}) as { convId?: unknown; deviceId?: unknown; boites?: unknown };
  if (typeof r.convId !== "string" || r.convId === "" || !entier(r.deviceId)) {
    return fail("« convId » et « deviceId » sont requis", 400, "BAD_BODY");
  }
  const convId = r.convId;
  const deviceId = r.deviceId;
  const boites = Array.isArray(r.boites) ? r.boites : [];
  if (boites.length === 0 || boites.length > BOITES_MAX) {
    return fail(`De 1 à ${BOITES_MAX} boîtes par dépôt`, 400, "BAD_BODY");
  }
  const lues = boites.map((b) => {
    const x = (b ?? {}) as Record<string, unknown>;
    return typeof x.destinataireId === "string" &&
      x.destinataireId !== "" &&
      entier(x.destinataireDevice) &&
      typeof x.corps === "string" &&
      x.corps.length > 0 &&
      x.corps.length <= CORPS_MAX
      ? { destinataireId: x.destinataireId, destinataireDevice: x.destinataireDevice, corps: x.corps }
      : null;
  });
  if (lues.some((b) => b === null)) return fail("Une boîte est mal formée", 400, "BAD_BODY");

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    select: {
      isGroup: true,
      e2eeActif: true,
      participants: {
        where: MEMBRE_ACTIF,
        orderBy: { joinedAt: "asc" },
        select: { userId: true, role: true },
      },
    },
  });
  if (!conv || !conv.participants.some((p) => p.userId === userId)) {
    return fail("Conversation inconnue", 404, "NOT_FOUND");
  }
  if (!conv.isGroup || !conv.e2eeActif) {
    return fail("Ce n'est pas un groupe chiffré", 409, "PAS_GROUPE_CHIFFRE");
  }
  const membres = new Set(conv.participants.map((p) => p.userId));
  if (lues.some((b) => !membres.has(b!.destinataireId))) {
    return fail("Destinataire hors du groupe", 403, "FORBIDDEN");
  }
  const admin = isGroupAdmin(conv.participants, userId);
  if (!admin && lues.some((b) => b!.destinataireId !== userId)) {
    return fail("Seul un administrateur dépose une boîte pour un autre membre.", 403, "ADMIN_REQUIS");
  }
  // L'appareil signataire doit être connu : sans lui, personne ne vérifierait.
  const identite = await prisma.e2eeIdentite.findUnique({
    where: { userId_deviceId: { userId, deviceId } },
    select: { id: true },
  });
  if (!identite) return fail("Cet appareil n'a pas publié ses clés.", 409, "APPAREIL_INCONNU");

  await prisma.$transaction(
    lues.map((b) =>
      prisma.e2eeBoite.upsert({
        where: {
          convId_userId_deviceId: { convId, userId: b!.destinataireId, deviceId: b!.destinataireDevice },
        },
        create: {
          convId,
          userId: b!.destinataireId,
          deviceId: b!.destinataireDevice,
          expediteurId: userId,
          expediteurDevice: deviceId,
          corps: b!.corps,
        },
        update: { expediteurId: userId, expediteurDevice: deviceId, corps: b!.corps, majLe: new Date() },
      }),
    ),
  );
  return ok({ deposees: lues.length });
});

export const GET = withAuth(async (req: NextRequest, userId: string) => {
  const deviceId = Number(req.nextUrl.searchParams.get("deviceId"));
  if (!Number.isInteger(deviceId)) return fail("« deviceId » est requis", 400, "BAD_BODY");
  const convId = req.nextUrl.searchParams.get("convId");
  /*
   * ⚠️ FILTRÉ SUR LES GROUPES DONT JE SUIS ENCORE MEMBRE. Le départ efface déjà
   * mes boîtes ; ce filtre est la seconde ceinture, comme pour les copies.
   */
  const boites = await prisma.e2eeBoite.findMany({
    where: {
      userId,
      deviceId,
      ...(convId ? { convId } : {}),
      conv: { isGroup: true, e2eeActif: true, participants: { some: { userId, ...MEMBRE_ACTIF } } },
    },
    select: { convId: true, expediteurId: true, expediteurDevice: true, corps: true, majLe: true },
  });
  return ok({ boites });
});
