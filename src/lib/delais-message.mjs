/**
 * LES DÉLAIS POUR REVENIR SUR UN MESSAGE — décision du user, 07/10/2026.
 *
 *   - MODIFIER : 2 heures après l'envoi ;
 *   - SUPPRIMER POUR TOUT LE MONDE : 24 heures après l'envoi.
 *
 * « Supprimer pour moi » n'a pas de délai : il ne touche que son propre écran.
 *
 * 🔴 LE SERVEUR TRANCHE, LES CLIENTS NE FONT QU'ANTICIPER. Le web et le mobile
 * masquent l'action passé le délai, mais une horloge de téléphone se règle à
 * la main : c'est ici, sur l'heure du serveur, que la règle tient. Les deux
 * chemins — REST et WebSocket — appellent ces mêmes fonctions, pour que la
 * règle ne dépende pas de la voie empruntée.
 *
 * ⚠️ UNE MARGE DE DEUX MINUTES. L'utilisateur qui valide sa modification à
 * 1 h 59 ne doit pas se la voir refuser parce que la requête a mis quelques
 * secondes à traverser un réseau lent, ou parce que son horloge retarde un
 * peu sur la nôtre.
 */

export const DELAI_MODIFICATION_MS = 2 * 60 * 60 * 1000;
export const DELAI_SUPPRESSION_POUR_TOUS_MS = 24 * 60 * 60 * 1000;
export const MARGE_MS = 2 * 60 * 1000;

export const DELAI_MODIFICATION_DEPASSE = "DELAI_MODIFICATION_DEPASSE";
export const DELAI_SUPPRESSION_DEPASSE = "DELAI_SUPPRESSION_DEPASSE";

function age(envoyeLe, maintenant) {
  const t = envoyeLe instanceof Date ? envoyeLe.getTime() : new Date(envoyeLe).getTime();
  // Date illisible : on ne peut pas prouver que le délai est passé.
  if (Number.isNaN(t)) return 0;
  return maintenant - t;
}

/** Le code du refus, ou `null` si le message peut encore être modifié. */
export function refusDelaiModification(envoyeLe, maintenant = Date.now()) {
  return age(envoyeLe, maintenant) > DELAI_MODIFICATION_MS + MARGE_MS
    ? DELAI_MODIFICATION_DEPASSE
    : null;
}

/** Le code du refus, ou `null` si le message peut encore être supprimé pour tous. */
export function refusDelaiSuppression(envoyeLe, maintenant = Date.now()) {
  return age(envoyeLe, maintenant) > DELAI_SUPPRESSION_POUR_TOUS_MS + MARGE_MS
    ? DELAI_SUPPRESSION_DEPASSE
    : null;
}

// ─── Contrôles : node src/lib/delais-message.mjs ────────────────────────────
if (process.argv[1] && process.argv[1].endsWith("delais-message.mjs")) {
  let echecs = 0;
  const verifie = (nom, obtenu, attendu) => {
    const bon = obtenu === attendu;
    if (!bon) echecs++;
    console.log(`${bon ? "✓" : "✗"} ${nom}${bon ? "" : ` — obtenu ${obtenu}, attendu ${attendu}`}`);
  };
  const t0 = Date.parse("2026-10-07T10:00:00Z");
  const apres = (ms) => t0 + ms;
  const min = 60 * 1000;
  const h = 60 * min;

  verifie("modifier à 1 h 59", refusDelaiModification(new Date(t0), apres(119 * min)), null);
  verifie("modifier à 2 h pile", refusDelaiModification(new Date(t0), apres(2 * h)), null);
  verifie("modifier à 2 h 01 : marge réseau", refusDelaiModification(new Date(t0), apres(2 * h + 1 * min)), null);
  verifie("modifier à 2 h 03 : refusé", refusDelaiModification(new Date(t0), apres(2 * h + 3 * min)), DELAI_MODIFICATION_DEPASSE);
  verifie("modifier le lendemain : refusé", refusDelaiModification(new Date(t0), apres(26 * h)), DELAI_MODIFICATION_DEPASSE);
  verifie("date en chaîne ISO", refusDelaiModification("2026-10-07T10:00:00Z", apres(3 * h)), DELAI_MODIFICATION_DEPASSE);

  verifie("supprimer à 23 h 59", refusDelaiSuppression(new Date(t0), apres(24 * h - 1 * min)), null);
  verifie("supprimer à 24 h 01 : marge réseau", refusDelaiSuppression(new Date(t0), apres(24 * h + 1 * min)), null);
  verifie("supprimer à 24 h 03 : refusé", refusDelaiSuppression(new Date(t0), apres(24 * h + 3 * min)), DELAI_SUPPRESSION_DEPASSE);
  verifie("supprimer à 3 h : permis (le délai de 2 h ne vaut que pour modifier)", refusDelaiSuppression(new Date(t0), apres(3 * h)), null);

  verifie("date illisible : pas de refus", refusDelaiModification("n'importe quoi", apres(99 * h)), null);
  verifie("horloge cliente en avance (date future)", refusDelaiModification(new Date(t0 + 5 * min), t0), null);

  console.log(echecs === 0 ? "\nTous les contrôles passent." : `\n${echecs} ÉCHEC(S).`);
  process.exit(echecs === 0 ? 0 : 1);
}
