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

/**
 * Plafond d'une page EN OCTETS, en plus du nombre de blocs.
 *
 * 🐛 LA PAGE N'ÉTAIT BORNÉE QU'EN NOMBRE : 2 000 blocs de 512 Ko, c'est 1 Go
 * chargé et sérialisé par UNE lecture — le processus Next tombait, pour tout le
 * monde. Prouvé par `scripts/e2ee-archive-banc.mjs` ⑩ le 28/09/2026.
 *
 * ⚠️ UN BLOC PASSE TOUJOURS, même seul au-dessus du plafond (512 Ko < 8 Mo de
 * toute façon) : une page vide avec un `suivant` ferait tourner le client en
 * rond.
 */
const PAGE_OCTETS = 8 * 1024 * 1024;

/**
 * Plafond d'une archive entière, en caractères base64.
 *
 * 🐛 RIEN NE LIMITAIT LE DÉPÔT : un compte pouvait remplir le disque du
 * serveur. 256 Mo couvrent plusieurs centaines de milliers de messages — un
 * usage réel n'en approche pas ; un abus, si.
 */
const VOLUME_MAX = 256 * 1024 * 1024;

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

  const [{ volume }] = await prisma.$queryRaw<{ volume: bigint }[]>`
    SELECT COALESCE(SUM(LENGTH(contenu)), 0)::bigint AS volume
    FROM e2ee_archive_blocs WHERE "alanyaID" = ${userId}::uuid`;
  if (Number(volume) + r.contenu.length > VOLUME_MAX) {
    return fail(
      "Archive pleine : effacez-la ou désactivez la sauvegarde.",
      413,
      "ARCHIVE_PLEINE",
    );
  }

  const bloc = await prisma.e2eeArchiveBloc.create({
    data: { userId, iv: r.iv, contenu: r.contenu, nbMessages },
    select: { id: true, createdAt: true },
  });

  return ok({ bloc }, 201);
});

export const GET = withAuth(async (req: NextRequest, userId: string) => {
  /*
   * ══════════════ PAR PAGES, JUSQU'AU BOUT ══════════════
   *
   * 🐛 LA LECTURE S'ARRÊTAIT À 2 000 BLOCS, du plus ancien au plus récent :
   * au-delà, la restauration perdait les messages les PLUS RÉCENTS, et `total`
   * valait le nombre RENDU, pas le nombre existant — rien ne le signalait. À
   * 10 messages par bloc côté web, c'est 20 000 messages. Prouvé par
   * `scripts/e2ee-archive-banc.mjs` ⑧ (2 000 relus sur 2 100).
   *
   * → `suivant` : l'identifiant du dernier bloc rendu quand la page est pleine,
   *   `null` sinon. Le client rappelle avec `?apres=<suivant>` jusqu'à `null`.
   *
   * ⚠️ UN CURSEUR, PAS UN DÉCALAGE (`skip`) : un bloc déposé pendant la lecture
   * décalerait les pages suivantes, et un bloc serait lu deux fois ou jamais.
   *
   * ⚠️ `id` DEPARTAGE LES EX-ÆQUO : deux blocs déposés la même milliseconde
   * n'ont pas d'ordre défini sur `createdAt` seul, et un curseur a besoin d'un
   * ordre TOTAL.
   *
   * ⚠️ SANS `apres`, LA PREMIÈRE PAGE EST CELLE D'AVANT : un client antérieur
   * reçoit exactement ce qu'il recevait, et ignore `suivant`.
   */
  const apres = req.nextUrl.searchParams.get("apres");
  if (apres !== null) {
    // Le curseur doit être à MOI : sans ce contrôle, un identifiant de bloc
    // d'un autre compte ferait partir la lecture d'un point quelconque.
    const repere = await prisma.e2eeArchiveBloc.findFirst({
      where: { id: apres, userId },
      select: { id: true },
    });
    if (!repere) return fail("« apres » inconnu", 400, "BAD_BODY");
  }

  /*
   * ⚠️ EN TROIS TEMPS, pour ne jamais charger ce qu'on ne rendra pas : les
   * identifiants de la page (un de plus, pour savoir s'il reste des blocs),
   * puis leur TAILLE seulement, puis le contenu des seuls blocs retenus sous
   * `PAGE_OCTETS`.
   */
  const tete = await prisma.e2eeArchiveBloc.findMany({
    where: { userId },
    select: { id: true },
    /*
     * ⚠️ DU PLUS ANCIEN AU PLUS RÉCENT. Le client dédoublonne par identifiant de
     * message et garde le DERNIER vu : dans cet ordre, une correction déposée
     * plus tard l'emporte sur la version d'origine. L'ordre inverse figerait la
     * première écriture.
     */
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: BLOCS_MAX + 1,
    ...(apres ? { cursor: { id: apres }, skip: 1 } : {}),
  });

  const candidats = tete.slice(0, BLOCS_MAX).map((b) => b.id);
  const tailles =
    candidats.length > 0
      ? await prisma.$queryRaw<{ id: string; n: number }[]>`
          SELECT id::text AS id, LENGTH(contenu)::int AS n
          FROM e2ee_archive_blocs WHERE id = ANY(${candidats}::uuid[])`
      : [];
  const taille = new Map(tailles.map((t) => [t.id, t.n]));
  const retenus: string[] = [];
  let octets = 0;
  for (const id of candidats) {
    const n = taille.get(id) ?? 0;
    if (retenus.length > 0 && octets + n > PAGE_OCTETS) break;
    retenus.push(id);
    octets += n;
  }
  const lignes = await prisma.e2eeArchiveBloc.findMany({
    where: { id: { in: retenus } },
    select: { id: true, iv: true, contenu: true },
  });
  const parId = new Map(lignes.map((l) => [l.id, l]));
  const blocs = retenus.map((id) => parId.get(id)).filter((b) => b !== undefined);

  // Un bloc de plus existe au-delà de ceux rendus : on donne le curseur.
  const suivant = retenus.length < tete.length ? retenus[retenus.length - 1] : null;
  /*
   * 🔴 LE NOMBRE TOTAL DE BLOCS, pour la barre de progression de l'écran de
   * restauration (28/09/2026). `total` ne compte que CETTE page — le nom est
   * trompeur, mais les clients le lisent déjà : on ne le change pas.
   *
   * ⚠️ SUR LA PREMIÈRE PAGE SEULEMENT : c'est là que le client en a besoin,
   * et un `count` par page ne servirait à rien.
   */
  const totalArchive =
    apres === null ? await prisma.e2eeArchiveBloc.count({ where: { userId } }) : undefined;
  return ok({
    blocs: blocs.map(({ iv, contenu }) => ({ iv, contenu })),
    total: blocs.length,
    ...(totalArchive !== undefined ? { totalArchive } : {}),
    suivant,
  });
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
