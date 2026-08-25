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
 *   - par IDENTIFIANT DE RÉCUPÉRATION : { idRecuperation, publicNumber,
 *     password } — pour les comptes ouverts sans adresse depuis le 25/08/2026.
 *
 * 🔴 LE SECOND CHEMIN EXIGE DEUX ÉLÉMENTS (durci le 25/08/2026, à la demande du
 * user). L'identifiant seul suffisait d'abord ; c'était un secret UNIQUE, stocké
 * en clair, dont la fuite aurait ouvert tous les comptes sans adresse d'un coup.
 * Il faut désormais l'identifiant ET l'Alanya ID du compte.
 *
 * Ce que ce second facteur apporte réellement : l'Alanya ID n'est PAS un secret
 * — les contacts le connaissent — donc il n'ajoute pas d'entropie contre qui
 * vous cible déjà. Ce qu'il rend impossible, c'est la reprise EN MASSE : un
 * identifiant volé ne dit plus à quel compte il appartient. Une fuite de la
 * colonne cesse d'être une prise de contrôle de tous les comptes sans adresse
 * pour redevenir une attaque à mener compte par compte, contre un plafond de
 * cinq essais.
 *
 * ⚠️ Ce chemin n'a PAS de code à 6 chiffres, et ce n'est pas un oubli : il
 * n'existe aucun canal par lequel en envoyer un.
 *
 * Des champs tous facultatifs plutôt qu'une `union` : cette forme REFUSE les
 * mélanges (une adresse avec un identifiant, un identifiant avec un code) au
 * lieu d'en choisir un en silence. Une demande ambiguë sur une route de
 * récupération de compte doit être rejetée, jamais devinée.
 */
const schema = z
  .object({
    email: z.string().trim().toLowerCase().email().optional(),
    code: z.string().trim().regex(/^\d{6}$/, "Le code doit comporter 6 chiffres").optional(),
    idRecuperation: z.string().trim().min(1).optional(),
    /**
     * L'Alanya ID du compte à reprendre — second facteur du chemin par
     * identifiant.
     *
     * ⚠️ PAS `publicNumberSchema` ICI. Ce schéma refuse ce qui n'a pas 3 à 10
     * chiffres, et la saisie arrive telle que l'utilisateur l'a tapée — souvent
     * formatée « 12 34 56 78 », comme les clients l'AFFICHENT. La normalisation
     * se fait plus bas, avant la recherche ; valider avant elle rejetterait une
     * saisie parfaitement correcte.
     */
    publicNumber: z.string().trim().min(1).optional(),
    password: motDePasse,
  })
  .superRefine((d, ctx) => {
    const parAdresse = d.email !== undefined || d.code !== undefined;
    const parIdentifiant = d.idRecuperation !== undefined || d.publicNumber !== undefined;

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
    // Le chemin par identifiant exige les DEUX ÉLÉMENTS. C'est toute la valeur
    // du durcissement : accepter l'un sans l'autre ramènerait au facteur unique
    // qu'on vient de retirer.
    if (parIdentifiant && (d.idRecuperation === undefined || d.publicNumber === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "La récupération par code exige le code de récupération ET l'Alanya ID du compte.",
        path: [d.idRecuperation === undefined ? "idRecuperation" : "publicNumber"],
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
      /*
       * L'Alanya ID est réduit à ses CHIFFRES. Les trois clients l'affichent
       * formaté — « 12 34 56 78 » — et c'est donc sous cette forme que
       * l'utilisateur le connaît et le recopie. La colonne, elle, ne porte que
       * les chiffres. Sans cette réduction, la saisie la plus naturelle serait
       * la seule à ne jamais fonctionner.
       */
      const numero = (demande.publicNumber ?? "").replace(/\D/g, "");

      /*
       * ⚠️ UN SEUL ET MÊME REFUS POUR LES DEUX ÉLÉMENTS, y compris pour une
       * forme manifestement invalide.
       *
       * Dire « ce code n'a pas la bonne longueur » puis « ce compte n'existe
       * pas » rendrait les deux facteurs testables SÉPARÉMENT : qui détient un
       * code volé pourrait balayer les Alanya ID jusqu'à voir le message
       * changer, et retrouver ainsi le compte auquel il appartient — ce que le
       * second facteur existe précisément pour empêcher.
       *
       * Le message reste actionnable pour un utilisateur légitime : il lui dit
       * de revérifier les deux, ce qu'il peut faire, alors qu'il ne peut rien
       * faire de plus avec un diagnostic précis.
       */
      const formeValide =
        identifiant.length === LONGUEUR_ID_RECUPERATION && numero.length > 0;

      const compte = formeValide
        ? await prisma.user.findFirst({
            // LES DEUX doivent désigner le MÊME compte. `findFirst` et non
            // `findUnique` : `idRecuperation` est unique, mais la requête porte
            // ici sur deux colonnes, et Prisma n'accepte pas un `findUnique`
            // hors d'une clé déclarée.
            where: { idRecuperation: identifiant, publicNumber: numero },
            select: { id: true },
          })
        : null;
      /*
       * ⚠️ UN SEUL MESSAGE, QUEL QUE SOIT L'ÉLÉMENT FAUTIF.
       *
       * Le message disait « identifiant de récupération inconnu » quand le code
       * seul suffisait, et c'était alors défendable : il n'était connu que de
       * son porteur. Avec deux facteurs, distinguer les cas les rendrait
       * testables l'un après l'autre — c'est exactement ce que le second facteur
       * est là pour empêcher.
       *
       * 404 et non 401 : rien ici n'est une question d'authentification, c'est
       * la paire qui ne désigne aucun compte.
       */
      if (!compte) {
        return fail(
          "Code de récupération ou Alanya ID incorrect",
          404,
          "RECOVERY_UNKNOWN",
        );
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
