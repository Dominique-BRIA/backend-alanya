import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { motifRefus } from "@/lib/e2ee-perimetre";
import { isGroupAdmin } from "@/lib/groups";
import { deposerMessageSysteme, nomPourAvis } from "@/lib/messages-systeme";

/**
 * ACTIVER LE CHIFFREMENT SUR UNE CONVERSATION.
 *
 * `GET  /api/conversations/<id>/e2ee` → est-elle chiffrée ? tout le monde a-t-il
 *                                       des clés ? qui peut l'activer ?
 * `POST /api/conversations/<id>/e2ee` → l'activer
 *
 * 🔴 L'ACTIVATION EST À SENS UNIQUE, ET C'EST VOULU. Une fois chiffrés, les
 * messages le RESTENT : le serveur n'a pas de quoi les rouvrir pour les reranger
 * en clair. Proposer de « désactiver » laisserait croire qu'on peut revenir en
 * arrière — on ne le peut pas, et un fil à moitié lisible est pire qu'un fil
 * dont on sait qu'il est fermé.
 *
 * 🔴 LE PÉRIMÈTRE N'EST PAS DÉCIDÉ ICI. Il vit dans `@/lib/e2ee-perimetre`
 * (types 0, 2, 3 et 4 depuis le 09/10/2026, refus provisoire des comptes qui
 * envoient par l'API). Cette route se contente de l'appliquer.
 *
 * 🔴 LES GROUPES (09/10/2026, `docs/2026-10-08-e2ee-groupes-conception.md`).
 *
 *   · SEUL UN ADMINISTRATEUR active. Un simple membre ne décide pas, pour
 *     trois cents personnes, que leurs messages deviennent illisibles sur un
 *     appareil sans trousseau.
 *   · L'activation crée la VERSION 1 de la clé du groupe, au nom de l'appareil
 *     qui va la tirer et la distribuer (`appareil` dans le corps). Le serveur
 *     ne voit jamais la clé : il note seulement QUI l'a créée, et QUAND.
 *   · Le drapeau et la version s'écrivent dans la MÊME transaction. Un groupe
 *     « chiffré » sans version 1 refuserait tous les messages ; une version 1
 *     sur un groupe resté en clair ne servirait à rien.
 *
 * ⚠️ ON REFUSE D'ACTIVER SI QUELQU'UN N'A PAS PUBLIÉ DE CLÉS. Sans ce contrôle,
 * la conversation basculerait et les messages de cette personne ne
 * partiraient nulle part — elle écrirait dans le vide, et son correspondant
 * attendrait une réponse qui n'existe pas. Mieux vaut refuser en le disant.
 */

/** La forme rendue par les deux verbes : l'état, et ce qui manque. */
async function etat(convId: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    select: {
      id: true,
      e2eeActif: true,
      isGroup: true,
      cleVersion: true,
      participants: {
        where: MEMBRE_ACTIF,
        // L'ordre d'arrivée : le repli « premier membre » d'`isGroupAdmin`
        // en dépend, pour les anciens groupes sans administrateur.
        orderBy: { joinedAt: "asc" },
        select: {
          userId: true,
          role: true,
          // Le TYPE de chaque compte, et s'il écrit par l'API : c'est ce que
          // juge `motifRefus`.
          user: { select: { typeCompte: true, developerAccount: { select: { id: true } } } },
        },
      },
    },
  });
  if (!conv) return null;

  const ids = conv.participants.map((p) => p.userId);

  /*
   * ⚠️ ON COMPTE LES IDENTITÉS PAR COMPTE, PAS LES COMPTES QUI EN ONT UNE.
   * Quelqu'un peut avoir publié des clés sur un appareil et pas sur un autre :
   * ce qui compte ici est qu'il en ait AU MOINS une, sans quoi il ne peut ni
   * lire ni écrire.
   */
  const avecCles = await prisma.e2eeIdentite.findMany({
    where: { userId: { in: ids } },
    select: { userId: true },
    distinct: ["userId"],
  });
  const prets = new Set(avecCles.map((i) => i.userId));

  /*
   * ⚠️ LA RÈGLE DE PÉRIMÈTRE EST CALCULÉE ICI, UNE SEULE FOIS, parce que le
   * `GET` et le `POST` doivent répondre la MÊME chose. Un écran qui affiche
   * « activable » sur une conversation que la route refusera ensuite est pire
   * qu'un bouton absent : il promet puis se dédit.
   */
  const refus = motifRefus(conv);

  return {
    conv,
    ids,
    refus,
    sansCles: ids.filter((id) => !prets.has(id)),
    // Qui peut activer : tout participant à deux, un administrateur en groupe.
    peutActiver: (uid: string) => !conv.isGroup || isGroupAdmin(conv.participants, uid),
  };
}

export const GET = withAuth(
  async (_req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id } = await ctx.params;
    const e = await etat(id);
    if (!e || !e.ids.includes(userId)) {
      return fail("Conversation inconnue", 404, "NOT_FOUND");
    }
    return ok({
      e2eeActif: e.conv.e2eeActif,
      groupe: e.conv.isGroup,
      cleVersion: e.conv.cleVersion,
      participants: e.ids.length,
      sansCles: e.sansCles,
      activable: e.refus === null && e.sansCles.length === 0,
      // Distinct d'`activable` : le bouton s'affiche pour l'administrateur,
      // les autres membres lisent « seul un administrateur peut l'activer ».
      jePeuxActiver: e.peutActiver(userId),
      // Pourquoi ce n'est pas activable, quand ça ne l'est pas : l'écran a
      // besoin de le DIRE, pas seulement de griser un bouton.
      motif: e.refus ?? (e.sansCles.length > 0 ? "CLES_MANQUANTES" : null),
    });
  },
);

export const POST = withAuth(
  async (req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id } = await ctx.params;
    const e = await etat(id);
    if (!e || !e.ids.includes(userId)) {
      return fail("Conversation inconnue", 404, "NOT_FOUND");
    }

    // Déjà chiffrée : on ne fait rien, et on ne se plaint pas. Deux appareils
    // du même compte peuvent demander en même temps.
    if (e.conv.e2eeActif) {
      return ok({ e2eeActif: true, deja: true, cleVersion: e.conv.cleVersion });
    }

    if (!e.peutActiver(userId)) {
      return fail(
        "Seul un administrateur du groupe peut activer le chiffrement.",
        403,
        "ADMIN_REQUIS",
      );
    }

    /*
     * ⚠️ LE MÊME CALCUL QUE LE `GET`, pris au même endroit. Deux règles
     * jumelles finissent toujours par diverger, et celle-ci décide de ce que
     * le serveur peut encore lire.
     */
    if (e.refus === "HORS_PERIMETRE") {
      return fail(
        "Un participant a un type de compte que le chiffrement ne couvre pas.",
        400,
        "HORS_PERIMETRE",
      );
    }
    if (e.refus === "EMETTEUR_API") {
      return fail(
        "Ce correspondant envoie des messages automatiques (codes, alertes) : " +
          "la conversation ne peut pas être chiffrée pour l'instant.",
        400,
        "EMETTEUR_API",
      );
    }
    if (e.sansCles.length > 0) {
      return fail(
        "Un participant n'a pas encore publié ses clés. Il doit ouvrir " +
          "l'application au moins une fois sur un appareil à jour.",
        409,
        "CLES_MANQUANTES",
      );
    }

    if (!e.conv.isGroup) {
      await prisma.conversation.update({
        where: { id },
        data: { e2eeActif: true },
      });
      return ok({ e2eeActif: true, deja: false });
    }

    /*
     * ⚠️ L'APPAREIL QUI ACTIVE DOIT AVOIR UNE IDENTITÉ PUBLIÉE. C'est lui qui
     * tirera la clé et signera ; les autres vérifieront sa signature avec la
     * clé d'identité qu'ils lui connaissent. Un appareil sans identité ne
     * pourrait rien distribuer : le groupe resterait muet.
     */
    let corps: unknown = null;
    try {
      corps = await req.json();
    } catch {
      // Corps absent ou illisible : refusé juste en dessous.
    }
    const appareil = (corps as { appareil?: unknown } | null)?.appareil;
    if (typeof appareil !== "number" || !Number.isInteger(appareil) || appareil < 1) {
      return fail("« appareil » (l'identifiant Signal de cet appareil) est requis", 400, "BAD_BODY");
    }
    const identite = await prisma.e2eeIdentite.findUnique({
      where: { userId_deviceId: { userId, deviceId: appareil } },
      select: { id: true },
    });
    if (!identite) {
      return fail("Cet appareil n'a pas publié ses clés.", 409, "CLES_MANQUANTES");
    }

    /*
     * ⚠️ LA BASCULE EST CONDITIONNELLE (`e2eeActif: false`). Deux
     * administrateurs qui activent au même instant : un seul crée la
     * version 1, l'autre reçoit « déjà ». Sans cette condition, le second
     * buterait sur la clé primaire de `e2ee_cle_versions` — une erreur 500
     * pour une situation parfaitement normale.
     */
    const cree = await prisma.$transaction(async (tx) => {
      const bascule = await tx.conversation.updateMany({
        where: { id, e2eeActif: false },
        data: { e2eeActif: true, cleVersion: 1 },
      });
      if (bascule.count === 0) return false;
      await tx.e2eeCleVersion.create({
        data: { convId: id, version: 1, creePar: userId, creeParAppareil: appareil, motif: "ACTIVATION" },
      });
      return true;
    });

    /*
     * L'AVIS « X A ACTIVÉ LE CHIFFREMENT » (lot 7) : les membres voient qui l'a
     * fait, et à partir d'où. Une seule fois — celui qui a gagné la course.
     */
    if (cree) {
      await deposerMessageSysteme(id, userId, "e2ee_active", { actor: await nomPourAvis(userId) });
    }

    return ok({ e2eeActif: true, deja: !cree, cleVersion: 1 });
  },
);
