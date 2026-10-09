import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { MEMBRE_ACTIF, membresActifs } from "@/lib/appartenance.mjs";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { isGroupAdmin } from "@/lib/groups";
import { previensDesPersonnes } from "@/lib/salle-temps-reel";

/**
 * UNE NOUVELLE VERSION DE LA CLÉ D'UN GROUPE CHIFFRÉ (lot 2c, cours ch. 31).
 *
 * `POST /api/conversations/<id>/e2ee/versions`
 *   corps : { attendue: n + 1, appareil: <id Signal>, motif: "EXCLUSION" | "MANUEL" }
 *
 * Après une EXCLUSION (décision du user : un départ volontaire n'en crée pas),
 * ou sur le bouton « Changer la clé du groupe ». L'appareil de
 * l'administrateur RÉSERVE ici le numéro, puis tire la clé et distribue le
 * trousseau aux membres restants. Le serveur ne voit jamais la clé : il tient
 * la NUMÉROTATION, pour que deux appareils ne créent pas deux clés différentes
 * sous le même numéro.
 *
 * 🔴 `attendue` REND LA RÉSERVATION ATOMIQUE. Deux administrateurs qui
 * changent la clé au même instant demandent tous deux `n + 1` : le premier
 * l'obtient, le second reçoit 409 avec la version courante, et sait qu'un
 * trousseau arrive. Sans ce numéro attendu, chacun aurait sa version, et la
 * moitié du groupe chiffrerait avec une clé que l'autre moitié n'a pas.
 *
 * ⚠️ RÉSERVER PUIS NE RIEN DISTRIBUER BLOQUE LE GROUPE : les envois exigent la
 * version courante, que personne n'a encore. Le remède est le même bouton :
 * n'importe quel administrateur réserve `n + 2` et distribue. Aucun message
 * n'est perdu — ils attendent sur les appareils.
 *
 * Pas d'historique réécrit : chaque message garde la version avec laquelle il
 * a été chiffré, et les membres gardent les anciennes clés pour le relire.
 */

const MOTIFS = new Set(["EXCLUSION", "MANUEL"]);

const entierPositif = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1;

export const POST = withAuth(
  async (req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id: convId } = await ctx.params;

    let corps: Record<string, unknown> = {};
    try {
      corps = ((await req.json()) ?? {}) as Record<string, unknown>;
    } catch {
      return fail("Corps JSON invalide", 400, "BAD_JSON");
    }
    const { attendue, appareil, motif } = corps;
    if (!entierPositif(attendue) || attendue < 2 || !entierPositif(appareil)) {
      return fail("« attendue » (≥ 2) et « appareil » sont requis", 400, "BAD_BODY");
    }
    if (typeof motif !== "string" || !MOTIFS.has(motif)) {
      return fail("« motif » : EXCLUSION ou MANUEL", 400, "BAD_BODY");
    }

    const conv = await prisma.conversation.findUnique({
      where: { id: convId },
      select: {
        isGroup: true,
        e2eeActif: true,
        cleVersion: true,
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
    if (!isGroupAdmin(conv.participants, userId)) {
      return fail("Seul un administrateur peut changer la clé du groupe.", 403, "ADMIN_REQUIS");
    }

    // L'appareil qui tirera la clé et signera doit être connu des membres.
    const identite = await prisma.e2eeIdentite.findUnique({
      where: { userId_deviceId: { userId, deviceId: appareil } },
      select: { id: true },
    });
    if (!identite) return fail("Cet appareil n'a pas publié ses clés.", 409, "APPAREIL_INCONNU");

    const reserve = await prisma.$transaction(async (tx) => {
      const pas = await tx.conversation.updateMany({
        where: { id: convId, cleVersion: attendue - 1, e2eeActif: true },
        data: { cleVersion: attendue },
      });
      if (pas.count === 0) return false;
      await tx.e2eeCleVersion.create({
        data: { convId, version: attendue, creePar: userId, creeParAppareil: appareil, motif },
      });
      return true;
    });

    if (!reserve) {
      const actuelle = await prisma.conversation.findUnique({
        where: { id: convId },
        select: { cleVersion: true },
      });
      return NextResponse.json(
        {
          error: {
            message: "La clé a déjà changé : un trousseau plus récent arrive.",
            code: "VERSION_CONFLIT",
            cleVersion: actuelle?.cleVersion ?? 0,
          },
        },
        { status: 409 },
      );
    }

    /*
     * « Une nouvelle version existe » : les appareils des membres savent qu'un
     * trousseau arrive, et retiennent leurs envois au lieu de buter sur
     * `VERSION_PERIMEE`. Ne fait jamais échouer la réservation.
     */
    await previensDesPersonnes({
      personnes: await membresActifs(prisma, convId),
      type: "e2ee_cle_version",
      donnees: { convId, version: attendue, motif },
    });

    return ok({ cleVersion: attendue }, 201);
  },
);
