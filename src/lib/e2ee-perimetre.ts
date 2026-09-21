/**
 * QUI A LE DROIT AU CHIFFREMENT DE BOUT EN BOUT.
 *
 * 🔴 UNE SEULE RÈGLE, UN SEUL FICHIER. Le périmètre du chiffrement se décide
 * ici et nulle part ailleurs : c'est la leçon des trois oublis du répondeur,
 * où la même règle vivait dans un fichier et manquait dans le suivant.
 *
 * ── CE QUE `users.type_compte` VEUT DIRE ────────────────────────────────
 *
 *   0 → compte NORMAL, une personne ordinaire ;
 *   2 → AGENT : une personne, mais rattachée à une entreprise, dont les
 *       échanges avec les clients sont le travail — et que sa hiérarchie relit ;
 *   3 → NUMÉRO DE CENTRE D'APPELS : le standard lui-même, pas quelqu'un ;
 *   4 → CENTRE VOCAL : un standard dont les touches jouent des sons ;
 *   9 → ADMINISTRATEUR (modération de la plateforme).
 *
 * ⚠️ ET LE 1 ? IL N EXISTE PAS — ou plus exactement, personne ne sait. Il n est
 * documenté nulle part, lu nulle part dans le code, et absent de la base. C est
 * la meilleure illustration de ce que la liste blanche apporte : ce type est
 * refusé SANS QUE QUICONQUE AIT EU A Y PENSER.
 *
 * Avec une liste noire, il aurait fallu deviner son existence pour l écarter —
 * et le jour où quelqu un s en servira, il serait chiffrable par défaut. La
 * question « pourquoi n exclut-on pas le 1 ? » n a donc pas de réponse : on
 * n exclut rien, on AUTORISE le seul type dont on sait ce qu il veut dire.
 *
 * 🐛 PREMIÈRE VERSION DE CETTE RÈGLE : ELLE N'EXCLUAIT QUE 3 ET 4.
 *
 * L'erreur venait d'un raisonnement plausible et faux — « un standard n'est pas
 * une personne, donc il faut l'exclure ; un agent EST une personne, donc il peut
 * chiffrer ». Or ce n'est pas la nature du titulaire qui compte, c'est QUI A
 * BESOIN DE LIRE. Les conversations d'un agent avec ses clients sont
 * exactement celles qu'un superviseur relit, qu'un transfert passe à un
 * collègue, et dont on tire des rapports. Les chiffrer casserait le centre
 * d'appels aussi sûrement que de chiffrer le standard lui-même.
 *
 * ⚠️ ON N'AUTORISE DONC QUE LE TYPE 0, par liste BLANCHE et non par liste noire.
 * Une liste noire oublie ce qui n'existe pas encore : le jour où un type 5
 * apparaîtra, il sera chiffrable par défaut, sans que personne ne l'ait décidé.
 * Une liste blanche refuse par défaut, et oblige à trancher.
 *
 * ⚠️ L'ADMINISTRATEUR (9) EST EXCLU LUI AUSSI, et c'est discutable : ses
 * conversations privées sont aussi personnelles que celles de n'importe qui. Il
 * est écarté par prudence — se tromper en refusant coûte un chiffrement qu'on
 * rétablit d'une ligne, se tromper en autorisant coûte une supervision qui ne
 * marche plus. Si le besoin se présente, c'est ici qu'on ajoute `9`, en le
 * sachant.
 */

/** Les seuls types de compte qui ouvrent droit au chiffrement. */
export const TYPES_PERSONNELS = [0];

/** Ce compte peut-il participer à une conversation chiffrée ? */
export function estComptePersonnel(
  user: { typeCompte?: number | null } | null | undefined,
): boolean {
  return TYPES_PERSONNELS.includes(Number(user?.typeCompte ?? -1));
}

/**
 * Pourquoi cette conversation ne peut-elle pas être chiffrée ?
 *
 * Rend `null` quand elle le peut. Le motif est fait pour être AFFICHÉ : un
 * bouton grisé sans explication fait ouvrir un ticket, pas comprendre une règle.
 */
export function motifRefus(conv: {
  isGroup: boolean;
  participants: { user: { typeCompte: number } | null }[];
}): "HORS_PERIMETRE" | "GROUPE_NON_SUPPORTE" | null {
  if (conv.participants.some((p) => !estComptePersonnel(p.user))) {
    return "HORS_PERIMETRE";
  }
  /*
   * ⚠️ LES GROUPES APRÈS LE PÉRIMÈTRE, ET NON AVANT : un groupe d'agents doit
   * s'entendre dire qu'il est hors périmètre, ce qui est définitif, plutôt que
   * « pas encore supporté », qui laisse espérer.
   */
  if (conv.isGroup) return "GROUPE_NON_SUPPORTE";
  return null;
}
