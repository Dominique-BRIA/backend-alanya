/**
 * Formate un Alanya ID pour l'affichage (pages publiques des liens QR).
 *
 * 🔴 MIROIR de deux autres fonctions, qui doivent rendre la même chose :
 *   · mobile : `formatAlanyaId`      (`lib/core/alanya_id_formatter.dart`)
 *   · web    : `formatAlanyaNumber`  (STAGE-WEB)
 * Un même identifiant affiché différemment selon l'endroit où on le lit est un
 * défaut qui ne se signale jamais tout seul. Toute modification de la règle se
 * fait dans les trois.
 *
 * Fichier SANS import, exécutable seul :
 *   node -e "import('./src/lib/format-alanya-id.mjs').then(m => console.log(m.formatAlanyaId('82312187')))"
 *
 * @param {string} brut
 * @returns {string}
 */
export function formatAlanyaId(brut) {
  const d = String(brut).replace(/\D/g, "");
  switch (d.length) {
    case 3:
      return d; // xxx
    case 4:
      return `${d.slice(0, 2)} ${d.slice(2)}`; // xx xx
    case 6:
      return `${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4)}`; // xx xx xx
    case 8:
      return `${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 6)} ${d.slice(6)}`; // xx xx xx xx
    case 10:
      return `${d.slice(0, 1)} ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}`; // x xxx xxx xxx
    default:
      // Toute autre longueur : une espace tous les deux chiffres.
      return d.replace(/(\d{2})(?=\d)/g, "$1 ");
  }
}
