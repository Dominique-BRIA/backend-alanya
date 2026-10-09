import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { MEMBRE_ACTIF, donneesDepart, donneesRetour } from "@/lib/appartenance.mjs";
import { invaliderConversation } from "@/lib/cache-redis.mjs";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { isGroupAdmin } from "@/lib/groups";
import { peutChiffrer } from "@/lib/e2ee-perimetre";
import { previensDesPersonnes } from "@/lib/salle-temps-reel";
import { nomAffichage } from "@/lib/display-name.mjs";
import { deposerMessageSysteme, nomPourAvis } from "@/lib/messages-systeme";
import { avatarPublicUrl } from "@/lib/avatar";

// GET /api/conversations/:id/members — liste les membres du groupe.
export const GET = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: {
      participants: {
        where: MEMBRE_ACTIF,
        include: { user: true },
      },
    },
  });
  if (!conv) return fail("Conversation introuvable", 404, "NOT_FOUND");

  const isMember = conv.participants.some((p) => p.userId === userId);
  if (!isMember) return fail("Accès refusé", 403, "FORBIDDEN");

  return ok({
    members: conv.participants.map((p) => ({
      id: p.userId,
      pseudo: nomAffichage(p.user),
      publicNumber: p.user.publicNumber,
      avatarUrl: avatarPublicUrl(p.user.avatarUrl ?? null),
      // Confidentialité : masque la présence d'un membre qui a choisi « personne ».
      isOnline:
        p.userId !== userId && p.user.lastSeenVisibility === 0
          ? 0
          : p.user.isOnline,
      role: p.role,
      joinedAt: p.joinedAt,
      /*
       * JUSQU'OÙ CE MEMBRE A LU. Même ajout que dans `GET /api/conversations`
       * (`8ad8fbf`), pour la même raison — et il manquait ICI, alors que c'est
       * cette route-ci que le mobile appelle en ouvrant un groupe.
       *
       * Sans lui, le compteur « N lu » ne connaîtrait que les lectures reçues
       * PENDANT qu'on regarde : il repartirait de zéro à chaque ouverture, et
       * tout ce qui a été lu avant serait invisible.
       *
       * `null` = ce membre n'a jamais ouvert la conversation. C'est une
       * information, pas une absence de donnée.
       *
       * Facultatif et additif : aucun champ existant ne bouge, aucune
       * migration — la colonne sert déjà aux non-lus et aux infos du message.
       */
      lastReadAt: p.lastReadAt ?? null,
    })),
  });
});

// POST /api/conversations/:id/members — ajouter des membres au groupe.
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  const { publicNumbers } = await req.json(); // string[]

  if (!Array.isArray(publicNumbers) || publicNumbers.length === 0) {
    return fail("Aucun numéro fourni", 400, "NO_NUMBERS");
  }

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: { participants: { where: MEMBRE_ACTIF } },
  });
  if (!conv) return fail("Conversation introuvable", 404, "NOT_FOUND");
  if (!conv.isGroup) return fail("Ce n'est pas un groupe", 400, "NOT_GROUP");

  // Seul un admin peut ajouter des membres (symétrique du retrait).
  const me = conv.participants.find((p) => p.userId === userId);
  if (!me) return fail("Accès refusé", 403, "FORBIDDEN");
  if (!isGroupAdmin(conv.participants, userId)) {
    return fail("Seul un admin peut ajouter des membres", 403, "NOT_ADMIN");
  }

  // Trouve les utilisateurs par numéro public
  const users = await prisma.user.findMany({
    where: { publicNumber: { in: publicNumbers } },
    select: { id: true, publicNumber: true, typeCompte: true },
  });

  const existingMemberIds = new Set(conv.participants.map((p) => p.userId));
  const toAdd = users.filter((u) => !existingMemberIds.has(u.id));

  if (toAdd.length === 0) {
    return fail("Tous les utilisateurs sont déjà membres", 400, "ALREADY_MEMBERS");
  }

  /*
   * 🔴 DANS UN GROUPE CHIFFRÉ, ON N'AJOUTE QUE QUELQU'UN QUI PEUT LIRE
   * (décision du user, 09/10/2026 : refus). Un type de compte hors périmètre,
   * ou un compte qui n'a publié de clés sur AUCUN appareil, ne pourrait ni
   * recevoir le trousseau ni déchiffrer quoi que ce soit : il verrait un
   * groupe muet. On refuse TOUT l'ajout, en nommant les numéros en cause,
   * plutôt que d'en ajouter une partie en silence.
   */
  if (conv.e2eeActif) {
    const avecCles = new Set(
      (
        await prisma.e2eeIdentite.findMany({
          where: { userId: { in: toAdd.map((u) => u.id) } },
          select: { userId: true },
          distinct: ["userId"],
        })
      ).map((i) => i.userId),
    );
    const horsPerimetre = toAdd.filter((u) => !peutChiffrer(u));
    const sansCles = toAdd.filter((u) => peutChiffrer(u) && !avecCles.has(u.id));
    if (horsPerimetre.length > 0) {
      return NextResponse.json(
        {
          error: {
            message: "Ce type de compte ne peut pas rejoindre un groupe chiffré.",
            code: "HORS_PERIMETRE",
            numeros: horsPerimetre.map((u) => u.publicNumber),
          },
        },
        { status: 409 },
      );
    }
    if (sansCles.length > 0) {
      return NextResponse.json(
        {
          error: {
            message:
              "Ce groupe est chiffré : la personne doit d'abord ouvrir Alanya sur " +
              "un appareil à jour pour publier ses clés.",
            code: "CLES_MANQUANTES",
            numeros: sansCles.map((u) => u.publicNumber),
          },
        },
        { status: 409 },
      );
    }
  }

  /*
   * 🔴 UN ANCIEN MEMBRE QUI REVIENT EST RÉACTIVÉ, PAS RECRÉÉ (09/10/2026). Sa
   * ligne existe encore (`est_membre = false`) : la recréer violerait
   * l'unicité (conversation, compte). Les deux écritures vont ensemble.
   */
  const anciens = new Set(
    (
      await prisma.participant.findMany({
        where: { convId, userId: { in: toAdd.map((u) => u.id) }, estMembre: false },
        select: { userId: true },
      })
    ).map((p) => p.userId),
  );
  await prisma.$transaction([
    prisma.participant.updateMany({
      where: { convId, userId: { in: [...anciens] }, estMembre: false },
      data: { ...donneesRetour(), role: "MEMBER" },
    }),
    prisma.participant.createMany({
      data: toAdd
        .filter((u) => !anciens.has(u.id))
        .map((u) => ({
          convId,
          userId: u.id,
          role: "MEMBER" as const,
        })),
    }),
  ]);
  /*
   * ⚠️ AVANT L'AVIS SYSTÈME QUI SUIT, PAS APRÈS. Cet avis est diffusé en temps
   * réel par le serveur WebSocket, qui demande alors la liste des membres : s'il
   * la lisait encore en cache, elle ne contiendrait pas les nouveaux venus, et
   * le message annonçant leur arrivée n'arriverait justement pas jusqu'à eux.
   */
  await invaliderConversation(convId);

  // Un avis par personne ajoutée : « X a été ajouté par Y ». Les noms sont
  // figés dans l'avis — si quelqu'un change de pseudo plus tard, l'historique
  // garde celui qu'il portait au moment de l'action.
  const auteur = await nomPourAvis(userId);
  for (const u of toAdd) {
    await deposerMessageSysteme(convId, userId, "member_added", {
      target: await nomPourAvis(u.id),
      actor: auteur,
    });
  }

  return ok({
    message: `${toAdd.length} membre(s) ajouté(s)`,
    added: toAdd.map((u) => u.publicNumber),
  });
});

// DELETE /api/conversations/:id/members?userId=xxx — retirer un membre du groupe.
// Le userId à retirer est passé en query param (pas en body JSON).
export const DELETE = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;

  // Lit le userId cible depuis l'URL query param
  const url = new URL(req.url);
  const targetId = url.searchParams.get("userId");

  if (!targetId) {
    return fail("userId manquant dans l'URL", 400, "MISSING_USER_ID");
  }

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: { participants: { where: MEMBRE_ACTIF } },
  });
  if (!conv) return fail("Conversation introuvable", 404, "NOT_FOUND");
  if (!conv.isGroup) return fail("Ce n'est pas un groupe", 400, "NOT_GROUP");

  // Seul un admin peut retirer des membres (ou soi-même qui quitte)
  const me = conv.participants.find((p) => p.userId === userId);
  if (!me) return fail("Accès refusé", 403, "FORBIDDEN");

  if (targetId !== userId && !isGroupAdmin(conv.participants, userId)) {
    return fail("Seul un admin peut retirer des membres", 403, "NOT_ADMIN");
  }

  const target = conv.participants.find((p) => p.userId === targetId);
  if (!target) return fail("Membre introuvable dans ce groupe", 404, "NOT_MEMBER");

  // Les noms sont lus AVANT la suppression : après, le participant n'est plus
  // là pour être nommé.
  const nomCible = await nomPourAvis(targetId);
  const nomAuteur = targetId === userId ? nomCible : await nomPourAvis(userId);

  /*
   * 🔴 LE DÉPART EST MARQUÉ, PAS EFFACÉ (09/10/2026, `appartenance.mjs`) :
   * `exclu_par` dit qui a retiré ; nul quand on part de soi-même. Sa copie
   * personnelle du trousseau d'un groupe chiffré part avec (décision du user).
   */
  await prisma.$transaction([
    prisma.participant.update({
      where: { convId_userId: { convId, userId: targetId } },
      data: donneesDepart(targetId === userId ? null : userId),
    }),
    prisma.e2eeTrousseau.deleteMany({ where: { convId, userId: targetId } }),
  ]);
  /*
   * 🔴 IMMÉDIATEMENT APRÈS LE RETRAIT. Cette liste est le contrôle d'accès de la
   * conversation : tant qu'une copie périmée circule, la personne retirée
   * continue d'y écrire et d'en recevoir les messages.
   */
  await invaliderConversation(convId);

  /*
   * 🔴 LE PARTANT EFFACE SON TROUSSEAU (groupe chiffré, décision du user). Ses
   * appareils sont prévenus ici ; les messages DÉJÀ LUS restent chez lui,
   * comme sur WhatsApp. Pas de nouvelle clé pour un départ volontaire ; pour
   * une exclusion, c'est l'appareil de l'administrateur qui la crée
   * (`e2ee/versions`).
   */
  if (conv.e2eeActif) {
    await previensDesPersonnes({
      personnes: [targetId],
      type: "e2ee_membre_parti",
      donnees: { convId, exclu: targetId !== userId },
    });
  }

  // Si c'est soi-même qui quitte, on peut aussi supprimer la conv si vide
  let convSupprimee = false;
  if (targetId === userId) {
    const remaining = await prisma.participant.count({ where: { convId, ...MEMBRE_ACTIF } });
    if (remaining === 0) {
      await prisma.conversation.delete({ where: { id: convId } });
      convSupprimee = true;
    }
  }

  // Un départ volontaire ne nomme pas d'auteur : « X a quitté le groupe ».
  // Retiré par quelqu'un d'autre, l'avis le dit : « X a été retiré par Y ».
  // Rien à déposer si la conversation vient d'être supprimée — le message
  // n'aurait plus de fil où vivre.
  if (!convSupprimee) {
    await (targetId === userId
      ? deposerMessageSysteme(convId, targetId, "member_left", { target: nomCible })
      : deposerMessageSysteme(convId, userId, "member_removed", {
          target: nomCible,
          actor: nomAuteur,
        }));
  }

  return ok({ message: "Membre retiré", userId: targetId });
});

// PATCH /api/conversations/:id/members — change le rôle d'un membre.
// Body : { userId: string, role: "ADMIN" | "MEMBER" }. Réservé aux admins.
export const PATCH = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  const { userId: targetId, role } = await req.json();

  if (typeof targetId !== "string" || (role !== "ADMIN" && role !== "MEMBER")) {
    return fail("Paramètres invalides", 400, "BAD_PARAMS");
  }

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: { participants: true },
  });
  if (!conv) return fail("Conversation introuvable", 404, "NOT_FOUND");
  if (!conv.isGroup) return fail("Ce n'est pas un groupe", 400, "NOT_GROUP");

  if (!isGroupAdmin(conv.participants, userId)) {
    return fail("Seul un admin peut changer les rôles", 403, "NOT_ADMIN");
  }

  const target = conv.participants.find((p) => p.userId === targetId);
  if (!target) return fail("Membre introuvable dans ce groupe", 404, "NOT_MEMBER");

  await prisma.participant.update({
    where: { convId_userId: { convId, userId: targetId } },
    data: { role },
  });

  return ok({
    message: role === "ADMIN" ? "Promu administrateur" : "Rétrogradé membre",
    userId: targetId,
    role,
  });
});
