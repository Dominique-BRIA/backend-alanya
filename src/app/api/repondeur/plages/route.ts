import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { aUnAccueil } from "@/lib/repondeur.mjs";

/**
 * LES PLAGES PROGRAMMÉES DU RÉPONDEUR.
 *
 * `GET    /api/repondeur/plages`         → les miennes, périmées comprises
 * `POST   /api/repondeur/plages`         → en poser une, ou plusieurs d'un coup
 * `DELETE /api/repondeur/plages?id=<id>` → en retirer une
 *
 * 🔴 CE N'EST PAS UNE VARIANTE DE L'ABSENCE, c'est un troisième mode. L'absence
 * dit « à partir de maintenant, et pendant trois heures ». Une plage dit « tous
 * les lundis, de 10 h à 12 h » — elle revient, et n'a pas de fin tant qu'on ne
 * la retire pas. C'est ce qui la rend dangereuse : d'où sa péremption
 * automatique au bout de deux semaines.
 */

/** Deux semaines. Au-delà, une programmation oubliée bloquerait les appels. */
const VALIDITE_MS = 14 * 24 * 60 * 60 * 1000;

/** Nombre maximal de plages par compte — sept jours, quelques plages par jour. */
const PLAGES_MAX = 40;

const CHAMPS = {
  id: true,
  jour: true,
  debutMin: true,
  finMin: true,
  fuseau: true,
  accueilId: true,
  createdAt: true,
  expireLe: true,
} as const;

/**
 * Un nom de fuseau que `Intl` reconnaît, ou `UTC`.
 *
 * ⚠️ CONTRÔLÉ ICI, PAS SEULEMENT À L'ÉCRAN. Ce champ est relu à chaque appel,
 * dans la fonction qui décide s'il faut faire sonner : une valeur que `Intl`
 * refuse y ferait lever une exception, et un appel disparaîtrait sans trace.
 */
function fuseauValide(brut: unknown): string {
  if (typeof brut !== "string" || brut.length === 0 || brut.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: brut });
    return brut;
  } catch {
    return "UTC";
  }
}

/** Une plage reçue du client, vérifiée. Rend `null` si elle n'a pas de sens. */
function lirePlage(brut: unknown) {
  const p = (brut ?? {}) as Record<string, unknown>;
  const jour = Number(p.jour);
  const debutMin = Number(p.debutMin);
  const finMin = Number(p.finMin);
  if (!Number.isInteger(jour) || jour < 0 || jour > 6) return null;
  if (!Number.isInteger(debutMin) || debutMin < 0 || debutMin > 1439) return null;
  if (!Number.isInteger(finMin) || finMin < 1 || finMin > 1440) return null;
  // Une plage qui finit avant de commencer ne s'ouvrirait jamais, et personne
  // ne comprendrait pourquoi. Elle est refusée, pas corrigée en silence.
  if (finMin <= debutMin) return null;
  return {
    jour,
    debutMin,
    finMin,
    fuseau: fuseauValide(p.fuseau),
    accueilId: typeof p.accueilId === "string" && p.accueilId !== "" ? p.accueilId : null,
  };
}

async function mesPlages(userId: string) {
  return prisma.repondeurPlage.findMany({
    where: { userId },
    // Par jour puis par heure : c'est l'ordre dans lequel on lit une semaine.
    orderBy: [{ jour: "asc" }, { debutMin: "asc" }],
    select: CHAMPS,
  });
}

export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  /*
   * ⚠️ LES PÉRIMÉES SONT RENDUES AUSSI, avec leur date. Les cacher ferait
   * disparaître de l'écran une programmation qu'on cherche justement à
   * retrouver pour la relancer, et laisserait croire qu'on ne l'a jamais posée.
   * C'est l'écran qui dit « expirée », pas la base qui l'efface.
   */
  return ok({ plages: await mesPlages(userId) });
});

export const POST = withAuth(async (req: NextRequest, userId: string) => {
  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return fail("Corps JSON invalide", 400, "BAD_JSON");
  }
  const recu = (corps ?? {}) as { plages?: unknown };
  const brutes = Array.isArray(recu.plages) ? recu.plages : [corps];

  const plages = brutes.map(lirePlage);
  if (plages.length === 0 || plages.some((p) => p === null)) {
    return fail("Plage invalide : jour 0-6, début < fin, minutes 0-1440", 400, "BAD_BODY");
  }

  const dejaLa = await prisma.repondeurPlage.count({ where: { userId } });
  if (dejaLa + plages.length > PLAGES_MAX) {
    return fail(`Pas plus de ${PLAGES_MAX} plages par compte`, 409, "TOO_MANY");
  }

  // Les accueils désignés doivent m'appartenir : sans ce contrôle on ferait
  // jouer à ses correspondants l'enregistrement de quelqu'un d'autre.
  const voulus = [...new Set(plages.map((p) => p!.accueilId).filter(Boolean))] as string[];
  if (voulus.length > 0) {
    const miens = await prisma.repondeurAccueil.count({
      where: { id: { in: voulus }, userId },
    });
    if (miens !== voulus.length) return fail("Accueil introuvable", 404, "NOT_FOUND");
  }

  const expireLe = new Date(Date.now() + VALIDITE_MS);
  await prisma.repondeurPlage.createMany({
    data: plages.map((p) => ({ ...p!, userId, expireLe })),
  });

  /*
   * ⚠️ POSER UNE PLAGE ALLUME LE RÉPONDEUR. Programmer « tous les lundis
   * 10 h-12 h » en laissant l'interrupteur éteint donnerait une programmation
   * qui ne fait rien, et rien à l'écran ne dirait pourquoi.
   *
   * 🐛 MAIS ALLUMER SANS ACCUEIL EST LE PIÈGE QUE LES DEUX AUTRES CHEMINS
   * FERMENT. L'interrupteur et l'absence refusent tous deux de s'allumer sur un
   * répondeur muet — un répondeur sans accueil laisse sonner, et celui qui
   * vient de régler quelque chose conclut que la fonction est cassée. Cette
   * route, écrite plus tard et dans un autre fichier, rouvrait ce piège : on
   * programmait ses lundis matin, l'interrupteur s'allumait, et le lundi venu
   * le téléphone sonnait comme d'habitude.
   *
   * Le contrôle vient APRÈS l'enregistrement des plages, volontairement : la
   * programmation est conservée, seul l'allumage est refusé. Enregistrer son
   * accueil ensuite suffit alors à la rendre effective, sans avoir à ressaisir
   * la semaine entière.
   */
  if (!(await aUnAccueil(prisma, userId))) {
    return fail(
      "Plages enregistrées. Enregistrez un message d'accueil pour qu'elles prennent effet : sans lui, les appels sonneraient comme d'habitude.",
      400,
      "NO_GREETING",
    );
  }
  await prisma.user.update({ where: { id: userId }, data: { repondeurActif: 1 } });

  return ok({ plages: await mesPlages(userId) }, 201);
});

export const DELETE = withAuth(async (req: NextRequest, userId: string) => {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return fail("« id » est requis", 400, "BAD_BODY");
  // `deleteMany` avec le propriétaire dans la condition : `delete` sur un id
  // seul supprimerait la ligne de quelqu'un d'autre si l'id fuitait.
  const { count } = await prisma.repondeurPlage.deleteMany({ where: { id, userId } });
  if (count === 0) return fail("Plage introuvable", 404, "NOT_FOUND");
  return ok({ plages: await mesPlages(userId) });
});
