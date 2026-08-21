import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createMeetingSchema } from "@/lib/validation";
import { randomUUID } from "crypto";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";
import { notifieInvitationReunion } from "@/lib/push";
import {
  plafondReunion,
  refusCreationTropGrande,
} from "@/lib/plafond-reunion";

// GET /api/meetings — liste les meetings de l'utilisateur (organisés ou participés).
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const meetings = await prisma.meeting.findMany({
    where: {
      OR: [
        { idOrganiser: userId },
        { participants: { some: { IDparticipant: userId } } },
      ],
    },
    orderBy: { start_time: "desc" },
    include: {
      organiser: true,
      participants: {
        include: { user: true },
      },
    },
  });

  return ok({
    meetings: meetings.map((m) => ({
      idMeeting: m.idMeeting,
      objet: m.objet,
      type_media: m.type_media,
      room: m.room,
      isEnd: m.isEnd,
      start_time: m.start_time,
      duree: m.duree,
      organiser: {
        id: m.organiser.id,
        pseudo: nomAffichage(m.organiser),
        publicNumber: m.organiser.publicNumber,
        avatarUrl: avatarPublicUrl(m.organiser.avatarUrl ?? null),
      },
      participants: m.participants.map((p) => ({
        ID: p.ID,
        IDparticipant: p.IDparticipant,
        pseudo: nomAffichage(p.user),
        publicNumber: p.user.publicNumber,
        avatarUrl: avatarPublicUrl(p.user.avatarUrl ?? null),
        status: p.status,
        connecte: p.connecte,
        start_time: p.start_time,
        duree: p.duree,
      })),
    })),
  });
});

// POST /api/meetings — crée une réunion et invite les participants.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const body = createMeetingSchema.parse(await req.json());

  // Résoudre les numéros publics → userId
  let participantIds: string[] = [];
  if (body.participantNumbers && body.participantNumbers.length > 0) {
    const users = await prisma.user.findMany({
      where: { publicNumber: { in: body.participantNumbers } },
      select: { id: true, publicNumber: true },
    });
    const foundNumbers = new Set(users.map((u) => u.publicNumber));
    const missing = body.participantNumbers.filter((n) => !foundNumbers.has(n));
    if (missing.length > 0) {
      return fail(
        `Numéro(s) introuvable(s) : ${missing.join(", ")}`,
        404,
        "NOT_FOUND",
      );
    }
    participantIds = users.map((u) => u.id);
    // Exclure l'organisateur s'il est dans la liste
    participantIds = participantIds.filter((id) => id !== userId);
  }

  // PLAFOND, DES LA CREATION — c'est explicitement le premier endroit ou il
  // doit mordre. Laisser naitre une reunion trop grande ne repousserait le
  // probleme que de quelques secondes : elle ne se reduit pas toute seule, et
  // chacun de ses invites decouvrirait le refus a la porte, un par un.
  //
  // L'ORGANISATEUR COMPTE. Il occupe une place dans le maillage comme les
  // autres, d'ou le `+ 1` : six invites plus lui font sept connexions par
  // machine, pas six. Sans ce `+ 1` le plafond serait faux d'une unite.
  //
  // Les limites sont celles du CREATEUR parce qu'il est l'organisateur : la
  // reunion sera la sienne, et c'est son entreprise qui en fixe le cadre.
  //
  // Le comptage se fait sur `participantIds` APRES resolution des numeros et
  // apres retrait de l'organisateur : compter les numeros bruts refuserait une
  // creation ou l'organisateur s'est mis dans sa propre liste, alors qu'elle ne
  // fait entrer personne de plus.
  const plafond = await plafondReunion(userId, body.type_media);
  const demandes = participantIds.length + 1;
  if (demandes > plafond) {
    return refusCreationTropGrande({
      typeMedia: body.type_media,
      plafond,
      demandes,
    });
  }

  const room = body.room ?? `room-${randomUUID().slice(0, 8)}`;

  const meeting = await prisma.meeting.create({
    data: {
      idOrganiser: userId,
      objet: body.objet,
      type_media: body.type_media,
      start_time: body.start_time ? new Date(body.start_time) : new Date(),
      duree: body.duree,
      room,
      isEnd: 0,
      participants: {
        create: participantIds.map((id) => ({
          IDparticipant: id,
          status: 0, // invité
        })),
      },
    },
    include: {
      participants: true,
      organiser: true,
    },
  });

  // Prévenir les invités.
  //
  // Rien ne les avertissait : la réunion se créait, les lignes `participant`
  // étaient posées, et personne ne l'apprenait avant d'ouvrir l'onglet Réunions
  // par hasard. Une invitation à laquelle on ne peut pas répondre parce qu'on
  // l'ignore n'en est pas une.
  //
  // Le push est le SEUL canal disponible depuis une route HTTP : le serveur
  // WebSocket est un process séparé, l'API n'a aucun moyen de lui parler. C'est
  // aussi le bon canal — il atteint un téléphone dont l'application est fermée,
  // ce que le WebSocket ne fait pas.
  //
  // En arrière-plan et sans `await` : une panne de Firebase ne doit pas faire
  // échouer une création de réunion parfaitement valide, déjà écrite en base.
  const organiserName = nomAffichage(meeting.organiser);
  const enCours = meeting.start_time.getTime() <= Date.now();
  for (const id of participantIds) {
    notifieInvitationReunion({
      recipientId: id,
      meetingId: meeting.idMeeting,
      objet: meeting.objet,
      organiserName: organiserName ?? "Un contact",
      enCours,
    }).catch((e) =>
      console.error("[meetings] notification d'invitation:", e?.message ?? e),
    );
  }

  return ok(
    {
      idMeeting: meeting.idMeeting,
      objet: meeting.objet,
      type_media: meeting.type_media,
      room: meeting.room,
      start_time: meeting.start_time,
      duree: meeting.duree,
      isEnd: meeting.isEnd,
      participantCount: meeting.participants.length,
    },
    201,
  );
});
