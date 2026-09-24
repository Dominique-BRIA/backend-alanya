import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { motifRefus } from "@/lib/e2ee-perimetre";

/**
 * ACTIVER LE CHIFFREMENT SUR UNE CONVERSATION.
 *
 * `GET  /api/conversations/<id>/e2ee` → est-elle chiffrée ? tout le monde a-t-il
 *                                       des clés ?
 * `POST /api/conversations/<id>/e2ee` → l'activer
 *
 * 🔴 L'ACTIVATION EST À SENS UNIQUE, ET C'EST VOULU. Une fois chiffrés, les
 * messages le RESTENT : le serveur n'a pas de quoi les rouvrir pour les reranger
 * en clair. Proposer de « désactiver » laisserait croire qu'on peut revenir en
 * arrière — on ne le peut pas, et un fil à moitié lisible est pire qu'un fil
 * dont on sait qu'il est fermé.
 *
 * 🔴 LE PÉRIMÈTRE EST DÉCIDÉ, ET IL EST ÉTROIT (21/09/2026).
 *
 * Le chiffrement de bout en bout ne couvre QUE les conversations entre DEUX
 * COMPTES PERSONNELS. Ce n'est pas une étape vers « tout chiffrer » : c'est la
 * limite définitive, et elle découle de ce qu'Alanya est.
 *
 * Sont exclus, et le resteront :
 *
 *   · TOUT LE CENTRE D'APPELS — les standards ET LES AGENTS. Un superviseur
 *     relit les échanges de ses agents ; un transfert passe la conversation à
 *     quelqu'un d'autre. Le bout en bout rend les deux impossibles — pas
 *     difficiles, IMPOSSIBLES.
 *
 *     🐛 LA PREMIÈRE VERSION DE CETTE RÈGLE N'EXCLUAIT QUE LES STANDARDS
 *     (types 3 et 4), en laissant passer les AGENTS (type 2). Le raisonnement
 *     était plausible et faux : « un agent est une personne, donc il peut
 *     chiffrer ». Ce n'est pas la nature du titulaire qui compte, c'est QUI A
 *     BESOIN DE LIRE. Voir `@/lib/e2ee-perimetre`.
 *
 *   · L'API DES ENTREPRISES (`/api/v1/messages`). Une entreprise qui écrit par
 *     clé d'API n'a AUCUNE identité cryptographique : pas de clé, pas de
 *     session, rien à chiffrer avec. Le serveur écrit pour son compte, ce que
 *     le bout en bout exclut par définition.
 *
 *   · LES GROUPES, tant que les « Sender Keys » ne sont pas implémentées.
 *
 * ⚠️ CE N'EST PAS UNE RESTRICTION TECHNIQUE QU'ON LÈVERA. Chiffrer un fil de
 * centre d'appels reviendrait à retirer au produit ce qui le fait vendre. La
 * question n'a jamais été « peut-on ? » mais « sur quoi ? », et la réponse est
 * ici.
 *
 * ⚠️ ON REFUSE D'ACTIVER SI QUELQU'UN N'A PAS PUBLIÉ DE CLÉS. Sans ce contrôle,
 * la conversation basculerait et les messages de cette personne ne
 * partiraient nulle part — elle écrirait dans le vide, et son correspondant
 * attendrait une réponse qui n'existe pas. Mieux vaut refuser en le disant.
 */

/** La forme rendue par les deux verbes : l'état, et ce qui manque. */
async function etat(convId: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    select: {
      id: true,
      e2eeActif: true,
      isGroup: true,
      participants: {
        select: {
          userId: true,
          // Le TYPE de chaque compte : c'est lui qui dit si la conversation
          // relève du périmètre personnel ou du produit professionnel.
          user: { select: { typeCompte: true } },
        },
      },
    },
  });
  if (!conv) return null;

  const ids = conv.participants.map((p) => p.userId);

  /*
   * ⚠️ ON COMPTE LES IDENTITÉS PAR COMPTE, PAS LES COMPTES QUI EN ONT UNE.
   * Quelqu'un peut avoir publié des clés sur un appareil et pas sur un autre :
   * ce qui compte ici est qu'il en ait AU MOINS une, sans quoi il ne peut ni
   * lire ni écrire.
   */
  const avecCles = await prisma.e2eeIdentite.findMany({
    where: { userId: { in: ids } },
    select: { userId: true },
    distinct: ["userId"],
  });
  const prets = new Set(avecCles.map((i) => i.userId));

  /*
   * ⚠️ LA RÈGLE DE PÉRIMÈTRE EST CALCULÉE ICI, UNE SEULE FOIS, parce que le
   * `GET` et le `POST` doivent répondre la MÊME chose. Un écran qui affiche
   * « activable » sur une conversation que la route refusera ensuite est pire
   * qu'un bouton absent : il promet puis se dédit.
   */
  const refus = motifRefus(conv);

  return {
    conv,
    ids,
    refus,
    sansCles: ids.filter((id) => !prets.has(id)),
  };
}

export const GET = withAuth(
  async (_req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id } = await ctx.params;
    const e = await etat(id);
    if (!e || !e.ids.includes(userId)) {
      return fail("Conversation inconnue", 404, "NOT_FOUND");
    }
    return ok({
      e2eeActif: e.conv.e2eeActif,
      participants: e.ids.length,
      sansCles: e.sansCles,
      activable: e.refus === null && e.sansCles.length === 0,
      // Pourquoi ce n'est pas activable, quand ça ne l'est pas : l'écran a
      // besoin de le DIRE, pas seulement de griser un bouton.
      motif: e.refus ?? (e.sansCles.length > 0 ? "CLES_MANQUANTES" : null),
    });
  },
);

export const POST = withAuth(
  async (_req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => {
    const { id } = await ctx.params;
    const e = await etat(id);
    if (!e || !e.ids.includes(userId)) {
      return fail("Conversation inconnue", 404, "NOT_FOUND");
    }

    // Déjà chiffrée : on ne fait rien, et on ne se plaint pas. Deux appareils
    // du même compte peuvent demander en même temps.
    if (e.conv.e2eeActif) return ok({ e2eeActif: true, deja: true });

    /*
     * ⚠️ LE MÊME CALCUL QUE LE `GET`, pris au même endroit. Deux règles
     * jumelles finissent toujours par diverger, et celle-ci décide de ce que
     * le serveur peut encore lire.
     */
    if (e.refus === "HORS_PERIMETRE") {
      return fail(
        "Le chiffrement de bout en bout ne couvre que les conversations " +
          "entre deux comptes personnels.",
        400,
        "HORS_PERIMETRE",
      );
    }
    if (e.refus === "GROUPE_NON_SUPPORTE") {
      return fail(
        "Le chiffrement de bout en bout ne couvre pas encore les groupes.",
        400,
        "GROUPE_NON_SUPPORTE",
      );
    }
    if (e.sansCles.length > 0) {
      return fail(
        "Un participant n'a pas encore publié ses clés. Il doit ouvrir " +
          "l'application au moins une fois sur un appareil à jour.",
        409,
        "CLES_MANQUANTES",
      );
    }

    await prisma.conversation.update({
      where: { id },
      data: { e2eeActif: true },
    });

    return ok({ e2eeActif: true, deja: false });
  },
);
