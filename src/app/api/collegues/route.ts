import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";
import {
  TYPE_COMPTE_AGENT,
  chercherCollegues,
  membresDuService,
  servicesDeLEntreprise,
  tousLesServicesVisibles,
} from "@/lib/collegues";

/**
 * GET /api/collegues            → les services de mon entreprise
 * GET /api/collegues?service=X  → les collègues du service X
 *
 * ── QUI Y A DROIT ────────────────────────────────────────────────────────
 *
 * Un AGENT, `type_compte = 2`, rattaché à une entreprise. La consigne d'origine
 * disait « type 3 » ; en production, les type 3 sont les STANDARDS eux-mêmes
 * (« Assistance Technique », « Clients Fidèles ») — des comptes de service, pas
 * des personnes. L'annuaire leur aurait été réservé, et caché aux collègues
 * qu'il concerne. Tranché avec le user le 25/08/2026.
 *
 * ⚠️ LE DROIT EST VÉRIFIÉ ICI, PAS SEULEMENT DANS L'ONGLET. Le client masque
 * l'onglet aux non-agents, mais un onglet masqué n'est pas un contrôle d'accès :
 * l'annuaire d'une entreprise n'a aucune raison de répondre à qui n'en fait pas
 * partie.
 *
 * ── UNE SEULE ROUTE, DEUX NIVEAUX ────────────────────────────────────────
 *
 * Le paramètre `service` distingue les deux, plutôt que deux chemins séparés :
 * le contrôle d'accès et la résolution de l'entreprise sont identiques, et les
 * écrire deux fois est le meilleur moyen de les laisser diverger.
 */
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  const moi = await prisma.user.findUnique({
    where: { id: userId },
    select: { idCompany: true, typeCompte: true },
  });
  if (!moi) return fail("Utilisateur introuvable", 404, "NOT_FOUND");

  if (moi.typeCompte !== TYPE_COMPTE_AGENT || moi.idCompany == null) {
    /*
     * 403 et non 404 : la route existe, elle ne s'adresse simplement pas à ce
     * compte. Un 404 laisserait croire à un chemin disparu et enverrait le
     * client chercher une panne là où il n'y en a pas.
     */
    return fail("Cet annuaire est réservé aux agents d'une entreprise", 403, "NOT_AGENT");
  }

  const service = req.nextUrl.searchParams.get("service");
  const requete = req.nextUrl.searchParams.get("q");

  /*
   * ── Recherche globale ────────────────────────────────────────────────
   *
   * Prioritaire sur les deux autres niveaux : elle traverse les services au
   * lieu de s'y ranger, et c'est ce qui lui permet de trouver un agent qu'AUCUN
   * service ne porte — cas réel en production.
   */
  if (requete !== null && requete.trim() !== "") {
    const trouves = await chercherCollegues(moi.idCompany, requete, userId);
    return ok({ recherche: requete, collegues: trouves.map(serialiseCollegue) });
  }

  // ── Niveau 1 : les services ────────────────────────────────────────────
  if (service === null) {
    const services = await servicesDeLEntreprise(moi.idCompany, userId);
    /*
     * `porteeRestreinte` EXISTE POUR QUE LE MESSAGE DE LISTE VIDE SOIT VRAI.
     *
     * Le client affichait « Aucun service n'est configuré pour ton entreprise »
     * dès que la liste revenait vide. Depuis que `company.collegue` peut
     * resserrer le répertoire au propre service de l'agent (27/08/2026), ce
     * texte peut être FAUX : des services existent, l'entreprise a simplement
     * choisi de n'en montrer qu'un, et celui-ci n'a personne — ou l'agent n'est
     * rattaché à aucun.
     *
     * Le serveur est le seul à connaître la raison. La taire enverrait
     * l'utilisateur signaler une panne de configuration qui n'existe pas.
     */
    return ok({
      services,
      porteeRestreinte: !(await tousLesServicesVisibles(moi.idCompany)),
    });
  }

  // ── Niveau 2 : les collègues d'un service ──────────────────────────────
  const membres = await membresDuService(moi.idCompany, service, userId);

  return ok({ service, collegues: membres.map(serialiseCollegue) });
});

/**
 * La forme d'un collègue, IDENTIQUE pour la recherche et pour un service.
 *
 * ⚠️ Une seule fonction pour les deux : deux sérialisations écrites séparément
 * finiraient par ne plus rendre les mêmes champs, et l'écran afficherait un
 * collègue complet ou amoindri selon le chemin par lequel on l'a trouvé.
 */
function serialiseCollegue(m: {
  id: string;
  publicNumber: string;
  nom: string | null;
  pseudo: string | null;
  avatarUrl: string | null;
  isOnline: number;
  lastSeen: Date | null;
  Fonctions?: { agence: { libelle: string } | null }[];
}) {
  return {
    id: m.id,
    publicNumber: m.publicNumber,
    // Le nom tel que les trois clients l'affichent partout ailleurs — même
    // règle de repli que dans les conversations et les appels.
    nom: nomAffichage(m),
    avatarUrl: avatarPublicUrl(m.avatarUrl ?? null),
    isOnline: m.isOnline,
    lastSeen: m.lastSeen ?? null,
    /*
     * L'AGENCE, ou `null` — jamais une chaîne vide ni un tiret.
     *
     * Un agent sans fonction rattachée n'a pas d'agence, et c'est un cas RÉEL :
     * `10000999` est dans ce cas en production. `null` laisse le client ne rien
     * afficher du tout ; un « — » lui ferait dessiner une ligne vide sous le
     * numéro, qui se lit comme une donnée manquante plutôt que comme une
     * information qui n'existe pas.
     *
     * La requête a déjà borné à mon entreprise et pris la première fonction :
     * ici on ne fait que déplier.
     */
    agence: m.Fonctions?.[0]?.agence?.libelle ?? null,
  };
}
