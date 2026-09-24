import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

/**
 * LE PAQUET DE PRÉ-CLÉS D'UN CORRESPONDANT — `GET /api/e2ee/cles/<userId>`.
 *
 * 🔴 C'EST LA ROUTE QUI REND X3DH ASYNCHRONE, et c'est tout son intérêt : elle
 * permet d'ouvrir une conversation chiffrée avec quelqu'un qui n'est PAS
 * connecté. Sans elle, il faudrait que les deux soient en ligne en même temps
 * pour s'échanger des clés — ce qu'aucune messagerie ne peut exiger.
 *
 * Elle rend UN paquet PAR APPAREIL du correspondant : le message devra être
 * chiffré autant de fois qu'il a d'appareils.
 *
 * ⚠️ ELLE CONSOMME UNE PRÉ-CLÉ À USAGE UNIQUE PAR APPAREIL. Ce n'est donc pas
 * une lecture : l'appeler en boucle vide le stock du correspondant, et un stock
 * vide dégrade la sécurité des sessions suivantes (voir plus bas). Le client ne
 * doit l'appeler qu'au moment d'ouvrir RÉELLEMENT une session.
 */

/** Plafond de paquets rendus d'un coup — un compte n'a pas cinquante appareils. */
const APPAREILS_MAX = 20;

/**
 * Au-delà de ce silence, on cesse de chiffrer pour un appareil.
 *
 * 🔴 TRENTE JOURS, ET C'EST UN COMPROMIS ASSUMÉ. Trop court, on cesserait
 * d'écrire à quelqu'un parti trois semaines en congé — ses messages seraient
 * perdus sans qu'il l'apprenne. Trop long, chaque compte traîne ses appareils
 * morts pendant des mois, et chaque message part en autant d'exemplaires
 * inutiles.
 *
 * ⚠️ L'APPAREIL N'EST PAS SUPPRIMÉ, il est IGNORÉ. Il redevient servi dès
 * qu'il relève à nouveau — un retour de congé ne doit rien coûter. Seule la
 * déconnexion explicite supprime, parce qu'elle est un geste, pas un silence.
 */
const SILENCE_MAX_MS = 30 * 24 * 60 * 60 * 1000;

export const GET = withAuth(
  // ⚠️ `Record<string, string>` ET NON `{ userId: string }` : c'est la
  // signature que `withAuth` impose a tous ses appelants. La resserrer ici la
  // rendrait incompatible — TypeScript refuse un parametre plus EXIGEANT que
  // celui du contrat.
  async (_req: NextRequest, _moi: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { userId } = await ctx.params;
    if (!userId) return fail("Destinataire manquant", 400, "BAD_BODY");

    const identites = await prisma.e2eeIdentite.findMany({
      where: {
        userId,
        /*
         * ⚠️ ON ÉCARTE LES IDENTITÉS QUI N'ONT PLUS DONNÉ SIGNE DE VIE.
         *
         * `null` passe : une identité qui n'a jamais relevé vient peut-être
         * d'être publiée, et refuser de lui écrire empêcherait le tout
         * premier message — celui-là même qui lui donnera une raison de
         * relever.
         */
        OR: [
          { derniereReleve: null },
          { derniereReleve: { gt: new Date(Date.now() - SILENCE_MAX_MS) } },
        ],
      },
      take: APPAREILS_MAX,
      select: {
        id: true,
        deviceId: true,
        registrationId: true,
        cleIdentite: true,
        prekeysSignees: {
          // La plus récente : c'est celle qu'on veut servir. Les précédentes
          // restent en base pour les messages déjà en vol.
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { prekeyId: true, clePublique: true, signature: true },
        },
      },
    });

    if (identites.length === 0) {
      /*
       * ⚠️ 404 ET NON UNE LISTE VIDE : « ce compte ne fait pas de chiffrement »
       * est une réponse, pas un résultat vide. Le client doit pouvoir la
       * distinguer sans interpréter — c'est elle qui lui dit de retomber sur
       * l'envoi en clair, ou de refuser d'écrire, selon ce qu'on aura décidé.
       */
      return fail("Aucune clé publiée pour ce compte", 404, "PAS_DE_CLES");
    }

    const paquets = [];
    for (const identite of identites) {
      const signee = identite.prekeysSignees[0];
      // Une identité sans pré-clé signée est inutilisable : X3DH exige la
      // signature pour écarter un serveur qui s'interposerait.
      if (!signee) continue;

      /*
       * 🔴 LA CONSOMMATION EST ATOMIQUE, ET ELLE DOIT L'ÊTRE.
       *
       * `updateMany` avec `consomme_le IS NULL` dans la condition : c'est la
       * base qui arbitre. Un « lire puis écrire » laisserait deux requêtes
       * simultanées emporter LA MÊME pré-clé, et servir deux fois la même
       * détruit la confidentialité persistante de la première session — le
       * genre de défaut qui ne se voit jamais à l'exécution.
       */
      const libre = await prisma.e2eePrekeyUnique.findFirst({
        where: { identiteId: identite.id, consommeLe: null },
        orderBy: { createdAt: "asc" },
        select: { id: true, prekeyId: true, clePublique: true },
      });

      let unique: { prekeyId: number; clePublique: string } | null = null;
      if (libre) {
        const { count } = await prisma.e2eePrekeyUnique.updateMany({
          where: { id: libre.id, consommeLe: null },
          data: { consommeLe: new Date() },
        });
        // `count === 0` : quelqu'un l'a prise entre la lecture et l'écriture.
        // On continue SANS pré-clé unique plutôt que de réessayer en boucle.
        if (count === 1) {
          unique = { prekeyId: libre.prekeyId, clePublique: libre.clePublique };
        }
      }

      paquets.push({
        deviceId: identite.deviceId,
        registrationId: identite.registrationId,
        cleIdentite: identite.cleIdentite,
        prekeySignee: signee,
        /*
         * ⚠️ `null` EST UN CAS NORMAL, PAS UNE ERREUR — le stock peut être
         * épuisé. X3DH fonctionne alors quand même, en sautant le quatrième
         * calcul Diffie-Hellman.
         *
         * 🔴 MAIS LA SESSION Y PERD : sans pré-clé à usage unique, deux
         * personnes qui ouvrent une session avec le même correspondant au même
         * moment partent du même matériau. C'est pourquoi le stock se
         * réapprovisionne, et pourquoi `GET /api/e2ee/cles` réclame.
         */
        prekeyUnique: unique,
      });
    }

    if (paquets.length === 0) {
      return fail("Aucune clé exploitable pour ce compte", 404, "PAS_DE_CLES");
    }

    return ok({ userId, paquets });
  },
);
