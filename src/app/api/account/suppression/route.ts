import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { verifyPassword } from "@/lib/password";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { ALANYA_ID_REGEX } from "@/lib/validation";

/**
 * POST /api/account/suppression — supprimer son compte DEPUIS LE WEB, sans
 * l'application (18/11/2026).
 *
 * 🔴 EXIGENCE DU PLAY STORE : une application qui crée des comptes doit offrir
 * la suppression dans l'application (`DELETE /api/account`, déjà là) ET par une
 * adresse web qui marche sans elle — la page `alanyavox.com/suppression-compte`.
 *
 * Corps : { identifier (e-mail ou Alanya ID), password }. Même effet que la
 * suppression dans l'application : le compte et tout ce qui en dépend.
 *
 * ⚠️ PROTÉGÉE COMME LA CONNEXION : 5 essais par minute et par adresse IP, et
 * la même réponse pour un compte inconnu ou un mauvais mot de passe — on ne
 * révèle pas quels comptes existent.
 */
export async function POST(req: NextRequest) {
  const rl = await rateLimit(`suppression-web:${clientIp(req)}`, 5, 60_000);
  if (!rl.allowed) return fail("Trop d'essais, réessayez dans une minute", 429, "RATE_LIMITED");

  const corps = ((await req.json().catch(() => null)) ?? {}) as { identifier?: unknown; password?: unknown };
  const identifiant = typeof corps.identifier === "string" ? corps.identifier.trim() : "";
  const motDePasse = typeof corps.password === "string" ? corps.password : "";
  if (!identifiant || !motDePasse) {
    return fail("Identifiant et mot de passe requis", 400, "MISSING_FIELDS");
  }

  const chiffres = identifiant.replace(/\D/g, "");
  const user = await prisma.user.findFirst({
    where: ALANYA_ID_REGEX.test(chiffres) && !identifiant.includes("@")
      ? { publicNumber: chiffres }
      : { email: identifiant.toLowerCase() },
    select: { id: true, passwordHash: true },
  });
  const valide = !!user?.passwordHash && (await verifyPassword(motDePasse, user.passwordHash));
  if (!user || !valide) return fail("Identifiant ou mot de passe incorrect", 400, "BAD_CREDENTIALS");

  await prisma.user.delete({ where: { id: user.id } });
  return ok({ message: "Compte supprimé" });
}
