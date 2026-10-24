import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * LA LANGUE D'UN COMPTE (24/10/2026).
 *
 * L'application déclare dans `Accept-Language` la langue CHOISIE dans ses
 * réglages (`api_client.dart`, `LocaleController.codeCourant`) ; le web fait de
 * même. On en garde la langue principale (`zh-Hans-CN` → `zh`), pour envoyer la
 * bienvenue et les diffusions de la console dans la bonne langue.
 */
export function langueDeRequete(req: NextRequest): string | null {
  const entete = req.headers.get("accept-language");
  if (!entete) return null;
  const premiere = entete.split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  const code = premiere.split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(code) ? code : null;
}

/**
 * Mémorise la langue déclarée, sans jamais faire échouer la requête qui
 * l'appelle : c'est un renseignement, pas une condition. N'écrit que si elle a
 * changé — la lecture du profil passe ici à chaque ouverture de l'application.
 */
export async function memoriserLangue(userId: string, req: NextRequest): Promise<void> {
  const langue = langueDeRequete(req);
  if (!langue) return;
  try {
    await prisma.user.updateMany({
      where: { id: userId, OR: [{ langue: null }, { langue: { not: langue } }] },
      data: { langue },
    });
  } catch (e) {
    console.error("[langue] mémorisation impossible :", e);
  }
}
