import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { z } from "zod";
import { verifyOtp } from "@/lib/otp";
import { hashPassword } from "@/lib/password";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import {
  normaliserIdRecuperation,
  LONGUEUR_ID_RECUPERATION,
} from "@/lib/id-recuperation";

const motDePasse = z
  .string()
  .min(8, "Le mot de passe doit faire au moins 8 caractères")
  .max(128);

/**
 * DEUX CHEMINS DE REPRISE, un seul point d'arrivée.
 *
 *   - par ADRESSE  : { email, code, password } — le parcours historique, avec
 *     son code à 6 chiffres reçu par courriel ;
 *   - par IDENTIFIANT DE RÉCUPÉRATION : { idRecuperation, password } — pour
 *     les comptes ouverts sans adresse depuis le 25/08/2026.
 *
 * ⚠️ Le second n'a PAS de code, et ce n'est pas un oubli : il n'existe aucun
 * canal par lequel en envoyer un. L'identifiant EST la preuve, ce qui en fait
 * un secret de la force d'un mot de passe — d'où le plafond de tentatives
 * ci-dessous, sans lequel ses 2^50 combinaisons ne protégeraient de rien.
 *
 * `union` et non des champs tous facultatifs : cette forme REFUSE les mélanges
 * (une adresse avec un identifiant, un identifiant avec un code) au lieu d'en
 * choisir un en silence. Une demande ambiguë sur une route de récupération de
 * compte doit être rejetée, jamais devinée.
 */
const schema = z
  .object({
    email: z.string().trim().toLowerCase().email().optional(),
    code: z.string().trim().regex(/^\d{6}$/, "Le code doit comporter 6 chiffres").optional(),
    idRecuperation: z.string().trim().min(1).optional(),
    password: motDePasse,
  })
  .superRefine((d, ctx) => {
    const parAdresse = d.email !== undefined || d.code !== undefined;
    const parIdentifiant = d.idRecuperation !== undefined;

    /*
     * 🐛 ÉCRIT D'ABORD EN `z.union`, ET C'ÉTAIT FAUX (constaté en exécutant la
     * route le 25/08/2026 : `{email, idRecuperation, password}` répondait 200 et
     * réinitialisait le mot de passe).
     *
     * Un `z.object` de zod RETIRE les clés qu'il ne connaît pas au lieu de les
     * refuser. L'union essayait donc la branche « adresse », échouait faute de
     * `code`, puis essayait la branche « identifiant » — qui réussissait en
     * jetant l'adresse en silence. La demande la plus ambiguë possible sur une
     * route de reprise de compte passait, et choisissait son chemin toute
     * seule.
     *
     * D'où ce contrôle explicite plutôt qu'une union : sur une route qui rend
     * un compte à quelqu'un, une demande qu'on ne sait pas lire doit être
     * REFUSÉE, jamais interprétée.
     */
    if (parAdresse && parIdentifiant) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Choisir UN chemin de récupération : une adresse avec son code, OU un identifiant de récupération.",
        path: ["idRecuperation"],
      });
      return;
    }
    if (!parAdresse && !parIdentifiant) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Fournir une adresse avec son code, ou un identifiant de récupération.",
        path: ["email"],
      });
      return;
    }
    // Le chemin par adresse exige les DEUX : une adresse sans code ne prouve
    // rien, et un code sans adresse ne désigne aucun compte.
    if (parAdresse && (d.email === undefined || d.code === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "La récupération par adresse exige l'adresse ET le code reçu.",
        path: [d.email === undefined ? "email" : "code"],
      });
    }
  });

const MAX_ATTEMPTS = 5;

/**
 * Pose le nouveau mot de passe ET FERME TOUTES LES SESSIONS.
 *
 * ⚠️ LA RÉVOCATION FAIT PARTIE DE LA RÉINITIALISATION, elle n'est pas un extra.
 * Quelqu'un qui reprend son compte le fait souvent PARCE QU'un autre y avait
 * accès : changer le mot de passe sans couper les sessions ouvertes laisserait
 * l'intrus connecté, avec un jeton parfaitement valide, sur le compte qu'on
 * vient de « récupérer ».
 *
 * Partagée par les DEUX chemins de reprise pour cette raison précise : le
 * chemin par identifiant de récupération est arrivé après, et l'écrire à part
 * aurait laissé la moitié des reprises sans cette coupure — la moitié qui, en
 * plus, concerne les comptes sans adresse, donc sans second recours.
 */
async function appliquerNouveauMotDePasse(userId: string, motDePasseClair: string) {
  const passwordHash = await hashPassword(motDePasseClair);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  await prisma.refreshToken.updateMany({
    where: { userId, revoked: false },
    data: { revoked: true },
  });
}

/**
 * Plafond des essais d'identifiant de récupération, par adresse IP.
 *
 * 🔴 C'EST LUI QUI DONNE SA VALEUR À L'ENTROPIE DE L'IDENTIFIANT. Sans plafond,
 * un attaquant essaie aussi vite que le réseau le permet ; avec 5 essais par
 * quart d'heure, épuiser 2^50 combinaisons demanderait plus de temps que l'âge
 * de l'univers.
 *
 * Plus sévère que le plafond général de la route (10/min) parce que la nature
 * de l'essai n'est pas la même : un code à 6 chiffres est envoyé à quelqu'un
 * qui le recopie et se trompe, un identifiant de récupération se recopie depuis
 * un papier. Cinq échecs d'affilée sur ce chemin ressemblent bien plus à une
 * recherche exhaustive qu'à une faute de frappe.
 */
const ESSAIS_ID_RECUPERATION = 5;
const FENETRE_ID_RECUPERATION_MS = 15 * 60_000;

// POST /api/auth/reset-password
// Vérifie le code OTP de réinitialisation et met à jour le mot de passe.
export async function POST(req: NextRequest) {
  try {
    const rl = rateLimit(`reset:${clientIp(req)}`, 10, 60_000);
    if (!rl.allowed) return fail("Trop de tentatives, réessayez plus tard", 429, "RATE_LIMITED");

    const demande = schema.parse(await req.json());

    // ═══ Chemin 2 : identifiant de récupération (compte sans adresse) ═══
    // `!== undefined` et non `in` : les champs sont désormais tous déclarés,
    // seule leur valeur distingue les deux chemins.
    if (demande.idRecuperation !== undefined) {
      const rlId = rateLimit(
        `reset-id:${clientIp(req)}`,
        ESSAIS_ID_RECUPERATION,
        FENETRE_ID_RECUPERATION_MS,
      );
      if (!rlId.allowed) {
        return fail("Trop de tentatives, réessayez plus tard", 429, "RATE_LIMITED");
      }

      // Normalisé AVANT la recherche : la colonne porte la forme majuscule sans
      // séparateur, et l'utilisateur recopie ce qu'il a noté à la main.
      const identifiant = normaliserIdRecuperation(demande.idRecuperation);
      if (identifiant.length !== LONGUEUR_ID_RECUPERATION) {
        return fail("Identifiant de récupération invalide", 400, "BAD_RECOVERY_ID");
      }

      const compte = await prisma.user.findUnique({
        where: { idRecuperation: identifiant },
        select: { id: true },
      });
      /*
       * ⚠️ ON DIT ICI QUE L'IDENTIFIANT EST INCONNU, alors que
       * `forgot-password` refuse de dire si une adresse existe. La différence
       * est voulue : une adresse est une donnée que d'autres connaissent, et
       * confirmer son inscription révèle quelque chose sur son titulaire. Un
       * identifiant de récupération n'est connu que de son porteur — l'énumérer
       * est déjà rendu vain par le plafond, et rester muet punirait surtout
       * celui qui a mal recopié son code sans jamais savoir pourquoi.
       */
      if (!compte) {
        return fail("Identifiant de récupération inconnu", 404, "RECOVERY_ID_UNKNOWN");
      }

      await appliquerNouveauMotDePasse(compte.id, demande.password);
      return ok({ message: "Mot de passe réinitialisé avec succès" });
    }

    // ═══ Chemin 1 : adresse + code à 6 chiffres (parcours historique) ═══
    // Le contrôle du schéma garantit que les deux sont là sur ce chemin ; le
    // `!` le dit à TypeScript, qui ne lit pas le `superRefine`.
    const email = demande.email!;
    const code = demande.code!;
    const password = demande.password;

    const record = await prisma.emailVerification.findFirst({
      where: { email, consumed: false },
      orderBy: { createdAt: "desc" },
    });
    if (!record) return fail("Aucun code en attente pour cet email", 400, "NO_OTP");
    if (record.expiresAt < new Date()) return fail("Code expiré", 400, "OTP_EXPIRED");
    if (record.attempts >= MAX_ATTEMPTS) {
      return fail("Trop de tentatives, redemandez un code", 429, "TOO_MANY_ATTEMPTS");
    }

    const valid = await verifyOtp(code, record.codeHash);
    if (!valid) {
      await prisma.emailVerification.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      return fail("Code incorrect", 400, "OTP_INVALID");
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return fail("Compte introuvable", 404, "NOT_FOUND");

    await appliquerNouveauMotDePasse(user.id, password);

    // Marque le code comme consommé pour éviter la réutilisation.
    await prisma.emailVerification.update({
      where: { id: record.id },
      data: { consumed: true },
    });

    return ok({ message: "Mot de passe réinitialisé avec succès" });
  } catch (err) {
    return handleError(err);
  }
}
