import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { estComptePersonnel } from "@/lib/e2ee-perimetre";

/**
 * L'ARCHIVE CHIFFRÉE — les blocs de messages.
 *
 * `POST   /api/e2ee/archive` → déposer un bloc
 * `GET    /api/e2ee/archive` → tout relire, pour restaurer
 * `DELETE /api/e2ee/archive` → tout effacer, blocs ET serrures
 *
 * 🔴 LE SERVEUR NE PEUT PAS OUVRIR UN BLOC, et n'en a pas les moyens : la clé
 * maîtresse est chiffrée dans `e2ee_serrures`, par un secret qu'il n'a pas.
 *
 * ⚠️ CE QU'IL VOIT : la taille, la date, et le nombre de messages annoncé. Des
 * métadonnées. Le chiffrement ne les cache pas plus ici qu'ailleurs, et le dire
 * vaut mieux que de laisser croire le contraire.
 */

/**
 * Plafond d'un bloc.
 *
 * ⚠️ UN BLOC EST UN LOT DE MESSAGES, PAS UNE ARCHIVE ENTIÈRE. Un client qui
 * enverrait tout d'un coup ferait une requête que rien ne peut reprendre après
 * une coupure — et bloquerait la mémoire du serveur le temps de la lire.
 */
const BLOC_MAX = 512 * 1024;

/** Plafond d'une restitution, pour borner la réponse. */
const BLOCS_MAX = 2000;

export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const moi = await prisma.user.findUnique({
    where: { id: userId },
    select: { typeCompte: true },
  });
  /*
   * ⚠️ `estComptePersonnel` PREND LE COMPTE, PAS SON `typeCompte`. Et on ne
   * se sert PAS de `motifRefus` : celui-ci juge une CONVERSATION — il répond
   * « groupe » ou « hors périmètre » pour un fil. Ici il n'y a pas de fil, il
   * y a un compte, et le seul motif possible est le périmètre.
   */
  if (!estComptePersonnel(moi)) {
    return fail(
      "Ce type de compte n'est pas couvert par le chiffrement.",
      403,
      "HORS_PERIMETRE",
    );
  }

  /*
   * 🔴 SANS SERRURE, PAS DE DÉPÔT. Un bloc déposé avant qu'une serrure existe
   * serait chiffré par une clé maîtresse que rien ne protège encore — et si le
   * navigateur se ferme entre les deux, personne ne pourra jamais le rouvrir.
   * On exige donc que la porte ait une clé avant d'y ranger quoi que ce soit.
   */
  const serrures = await prisma.e2eeSerrure.count({ where: { userId } });
  if (serrures === 0) {
    return fail(
      "Aucune serrure : posez-en une avant de sauvegarder.",
      409,
      "SANS_SERRURE",
    );
  }

  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return fail("Corps JSON invalide", 400, "BAD_JSON");
  }
  const r = (corps ?? {}) as Record<string, unknown>;

  if (typeof r.iv !== "string" || r.iv === "" || r.iv.length > 32) {
    return fail("« iv » manquant ou invalide", 400, "BAD_BODY");
  }
  if (typeof r.contenu !== "string" || r.contenu === "") {
    return fail("« contenu » manquant", 400, "BAD_BODY");
  }
  if (r.contenu.length > BLOC_MAX) {
    return fail("Bloc trop gros — découpez-le", 413, "TOO_LARGE");
  }
  const nbMessages = typeof r.nbMessages === "number" ? Math.floor(r.nbMessages) : 0;
  if (!Number.isFinite(nbMessages) || nbMessages < 1) {
    return fail("« nbMessages » doit être un entier positif", 400, "BAD_BODY");
  }

  const bloc = await prisma.e2eeArchiveBloc.create({
    data: { userId, iv: r.iv, contenu: r.contenu, nbMessages },
    select: { id: true, createdAt: true },
  });

  return ok({ bloc }, 201);
});

export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const blocs = await prisma.e2eeArchiveBloc.findMany({
    where: { userId },
    select: { iv: true, contenu: true },
    /*
     * ⚠️ DU PLUS ANCIEN AU PLUS RÉCENT. Le client dédoublonne par identifiant de
     * message et garde le DERNIER vu : dans cet ordre, une correction déposée
     * plus tard l'emporte sur la version d'origine. L'ordre inverse figerait la
     * première écriture.
     */
    orderBy: { createdAt: "asc" },
    take: BLOCS_MAX,
  });

  return ok({ blocs, total: blocs.length });
});

export const DELETE = withAuth(async (_req: NextRequest, userId: string) => {
  /*
   * 🔴 LES BLOCS ET LES SERRURES PARTENT ENSEMBLE, et c'est la seule conduite
   * honnête. Laisser les serrures derrière donnerait un coffre qui s'ouvre sur
   * du vide ; laisser les blocs sans serrure laisserait des octets que
   * PERSONNE ne pourra jamais lire, à commencer par leur propriétaire.
   *
   * ⚠️ DANS UNE TRANSACTION : à moitié fait, ce ménage produit exactement l'un
   * des deux états qu'on vient d'écarter.
   */
  /*
   * 🔴 EFFACER, C'EST REFUSER — et cette ligne est indispensable depuis que
   * la sauvegarde s'active d'elle-même. Sans elle, l'utilisateur supprime
   * son archive, se reconnecte, et la retrouve recréée. Il la supprimerait
   * encore, et encore.
   *
   * ⚠️ DANS LA MÊME TRANSACTION que la suppression : à moitié fait, on aurait
   * soit une archive sans refus (donc recréée), soit un refus sans
   * suppression (donc une archive orpheline qu'on n'alimente plus).
   */
  const [blocs, serrures] = await prisma.$transaction([
    prisma.e2eeArchiveBloc.deleteMany({ where: { userId } }),
    prisma.e2eeSerrure.deleteMany({ where: { userId } }),
    prisma.user.update({
      where: { id: userId },
      data: { e2eeSauvegardeRefusee: true },
    }),

  ]);

  return ok({ blocsSupprimes: blocs.count, serruresSupprimees: serrures.count });
});
