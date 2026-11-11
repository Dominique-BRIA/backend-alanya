import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import {
  groupesChiffresDe,
  lireChiffre,
  lireEntierPositif,
  lirePublique,
  previensManquants,
} from "@/lib/e2ee-v2";

/**
 * MA CLÉ DE COMPTE — chiffrement des groupes v2 (11/11/2026), conception § 3.1.
 *
 * `GET` → `{ cle: { version, publique, priveeChiffree } | null }`
 * `PUT` `{ version, publique, priveeChiffree }`
 *
 * La partie privée est chiffrée par la clé maîtresse de l'archive : le
 * serveur la garde sans pouvoir l'ouvrir. Tout appareil du compte la reprend
 * à la connexion (le mot de passe ouvre la clé maîtresse).
 *
 * Règles du `PUT` :
 *  - aucune clé : seule la version 1 est acceptée ;
 *  - même version et même partie publique : la partie privée chiffrée est
 *    remplacée (rechiffrement), rien d'autre ne change ;
 *  - version suivante : une NOUVELLE clé (clé maîtresse perdue, § 6.3) ;
 *  - tout le reste : 409 `VERSION_COMPTE`, avec la clé actuelle — l'appareil
 *    la relit au lieu d'en écraser une que ses autres appareils utilisent.
 *
 * Une clé nouvelle (première ou suivante) déclenche `e2ee_manquants` dans mes
 * groupes chiffrés : les membres qui ont les clés emballent pour elle.
 */
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const cle = await prisma.e2eeCleCompte.findUnique({
    where: { userId },
    select: { version: true, publique: true, priveeChiffree: true },
  });
  return ok({ cle });
});

export const PUT = withAuth(async (req: NextRequest, userId: string) => {
  const corps = ((await req.json().catch(() => null)) ?? {}) as {
    version?: unknown;
    publique?: unknown;
    priveeChiffree?: unknown;
  };
  const version = lireEntierPositif(corps.version, "version");
  const publique = lirePublique(corps.publique);
  const priveeChiffree = lireChiffre(corps.priveeChiffree, 4096, "priveeChiffree");

  const actuelle = await prisma.e2eeCleCompte.findUnique({ where: { userId } });
  const refus = () =>
    fail("Une autre clé de compte existe déjà : relisez-la", 409, "VERSION_COMPTE");

  let nouvelle = false;
  if (!actuelle) {
    if (version !== 1) return refus();
    await prisma.e2eeCleCompte.create({ data: { userId, version, publique, priveeChiffree } });
    nouvelle = true;
  } else if (version === actuelle.version) {
    if (publique !== actuelle.publique) return refus();
    await prisma.e2eeCleCompte.update({
      where: { userId },
      data: { priveeChiffree, majLe: new Date() },
    });
  } else if (version === actuelle.version + 1) {
    await prisma.e2eeCleCompte.update({
      where: { userId },
      data: { version, publique, priveeChiffree, majLe: new Date() },
    });
    nouvelle = true;
  } else {
    return refus();
  }

  if (nouvelle) {
    for (const convId of await groupesChiffresDe(userId)) {
      await previensManquants(convId, userId);
    }
  }
  return ok({ cle: { version, publique, priveeChiffree } });
});
