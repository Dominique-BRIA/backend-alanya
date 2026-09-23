import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { estComptePersonnel } from "@/lib/e2ee-perimetre";

/**
 * LES SERRURES DE L'ARCHIVE.
 *
 * `GET    /api/e2ee/coffre` → mes serrures (sans rien qui ouvre)
 * `PUT    /api/e2ee/coffre` → poser ou remplacer une serrure
 * `DELETE /api/e2ee/coffre?type=…` → en retirer une
 *
 * 🔴 CE QUE LE SERVEUR GARDE ICI NE LUI SERT À RIEN. `cleEnveloppee` est la clé
 * maîtresse chiffrée par une clé dérivée d'un secret qu'il n'a jamais vu. Le
 * sel, l'IV et les paramètres sont publics par construction : ils ne protègent
 * rien, ils permettent de REFAIRE la dérivation côté client.
 *
 * ⚠️ UNE EXCEPTION, ET ELLE EST ÉCRITE DANS LE PRODUIT : la serrure
 * « motdepasse » se dérive d'un secret que notre route de connexion reçoit en
 * clair. Un serveur compromis pourrait donc l'ouvrir. Elle protège l'archive au
 * repos, pas contre nous — voir `e2ee-serrures.ts` côté client.
 */

/** Les seuls types admis. Tout le reste est refusé. */
const TYPES = new Set(["trousseau", "motdepasse", "recuperation"]);

/**
 * Plafonds de forme.
 *
 * ⚠️ ILS NE SONT PAS DÉCORATIFS : ces colonnes sont des `VARCHAR`, et
 * PostgreSQL REFUSE une valeur trop longue au lieu de la couper. Sans contrôle
 * ici, une serrure malformée ferait remonter une erreur 500 illisible au lieu
 * d'un refus qui explique.
 */
const MAX = { sel: 64, iv: 32, cleEnveloppee: 128, algo: 20, parametres: 200 };

export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const serrures = await prisma.e2eeSerrure.findMany({
    where: { userId },
    select: {
      type: true,
      sel: true,
      iv: true,
      cleEnveloppee: true,
      algo: true,
      parametres: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  /*
   * ⚠️ ON REND TOUT, Y COMPRIS `cleEnveloppee` — et ce n'est pas une fuite :
   * sans le secret, ces octets ne sont qu'un chiffré authentifié. Les retenir
   * n'ajouterait aucune protection et empêcherait simplement de restaurer.
   */
  /*
   * ⚠️ LE REFUS VOYAGE AVEC LES SERRURES. Le client doit pouvoir
   * distinguer « pas encore activée » de « refusée » : la première appelle
   * une activation silencieuse, la seconde l'interdit.
   */
  const moi = await prisma.user.findUnique({
    where: { id: userId },
    select: { e2eeSauvegardeRefusee: true },
  });

  return ok({ serrures, refusee: moi?.e2eeSauvegardeRefusee === true });
});

export const PUT = withAuth(async (req: NextRequest, userId: string) => {
  /*
   * ⚠️ LE PÉRIMÈTRE S'APPLIQUE ICI AUSSI. Un compte hors périmètre n'a pas de
   * conversation chiffrée, donc rien à archiver. Le laisser poser des serrures
   * créerait un coffre vide que personne n'ouvrirait jamais — et donnerait à
   * penser que le chiffrement le concerne.
   */
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

  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return fail("Corps JSON invalide", 400, "BAD_JSON");
  }
  const r = (corps ?? {}) as Record<string, unknown>;

  const type = typeof r.type === "string" ? r.type : "";
  if (!TYPES.has(type)) return fail("Type de serrure inconnu", 400, "BAD_BODY");

  for (const champ of ["sel", "iv", "cleEnveloppee", "algo", "parametres"] as const) {
    const v = r[champ];
    if (typeof v !== "string" || v === "" || v.length > MAX[champ]) {
      return fail(`« ${champ} » manquante ou trop longue`, 400, "BAD_BODY");
    }
  }

  /*
   * 🔴 `upsert` SUR (COMPTE, TYPE), ET C'EST LA LIGNE QUI COMPTE.
   *
   * Reposer une serrure du même type REMPLACE l'ancienne. Sans cela, changer de
   * mot de passe laisserait derrière lui une serrure ouvrable par l'ANCIEN — et
   * en changer n'aurait rien changé du tout. La contrainte d'unicité en base
   * porte la même règle, pour qu'aucun autre chemin ne puisse la contourner.
   */
  const serrure = await prisma.e2eeSerrure.upsert({
    where: { userId_type: { userId, type } },
    create: {
      userId,
      type,
      sel: r.sel as string,
      iv: r.iv as string,
      cleEnveloppee: r.cleEnveloppee as string,
      algo: r.algo as string,
      parametres: r.parametres as string,
    },
    update: {
      sel: r.sel as string,
      iv: r.iv as string,
      cleEnveloppee: r.cleEnveloppee as string,
      algo: r.algo as string,
      parametres: r.parametres as string,
    },
    select: { type: true, updatedAt: true },
  });

  /*
   * ⚠️ POSER UNE SERRURE LÈVE LE REFUS. C'est le geste par lequel
   * l'utilisateur revient sur sa décision — le laisser en place
   * empêcherait toute réactivation future sans qu'on comprenne pourquoi.
   */
  await prisma.user.update({
    where: { id: userId },
    data: { e2eeSauvegardeRefusee: false },
  });

  return ok({ serrure }, 201);
});

export const DELETE = withAuth(async (req: NextRequest, userId: string) => {
  const type = req.nextUrl.searchParams.get("type") ?? "";
  if (!TYPES.has(type)) return fail("Type de serrure inconnu", 400, "BAD_BODY");

  /*
   * 🔴 ON REFUSE DE RETIRER LA DERNIÈRE. Une archive sans serrure ne se rouvre
   * JAMAIS — ni par l'utilisateur, ni par nous. Ce n'est pas une suppression,
   * c'est une destruction silencieuse, et elle se produirait au pire moment :
   * quelqu'un qui « fait le ménage » dans ses réglages.
   *
   * ⚠️ POUR TOUT EFFACER, IL FAUT LE DIRE : la route de l'archive supprime les
   * blocs ET les serrures ensemble, ce qui rend l'intention explicite.
   */
  const total = await prisma.e2eeSerrure.count({ where: { userId } });
  if (total <= 1) {
    return fail(
      "C'est la dernière serrure : la retirer rendrait l'archive définitivement illisible.",
      409,
      "DERNIERE_SERRURE",
    );
  }

  const { count } = await prisma.e2eeSerrure.deleteMany({ where: { userId, type } });
  return ok({ retiree: count > 0 });
});
