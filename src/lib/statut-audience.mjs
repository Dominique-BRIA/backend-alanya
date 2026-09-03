/**
 * QUI A LE DROIT DE VOIR LES STATUTS DE QUI.
 *
 * 🔴 CE FICHIER N'IMPORTE RIEN, ET C'EST VOLONTAIRE. La règle d'audience est
 * la seule chose qui protège un statut : elle doit pouvoir être EXÉCUTÉE
 * contre des cas, pas seulement relue. `node src/lib/statut-audience.mjs`
 * déroule ses contrôles.
 *
 * ⚠️ CETTE RÈGLE EST APPLIQUÉE À QUATRE ENDROITS — le fil (`GET /api/statuses`),
 * le binaire d'un média de statut (`GET /api/media/:id`), l'enregistrement
 * d'une vue (`POST /api/statuses/:id/view`) et la liste des vues. Les quatre
 * DOIVENT passer par ici. Une vignette qui s'affiche sans que son contenu
 * s'ouvre, c'est exactement ce qui arrive quand deux d'entre eux divergent —
 * on l'a vécu le 02/09 avec le média, refusé en 403 alors que le fil le
 * listait.
 */

/** Les trois audiences, dans l'ordre où l'écran de réglages les présente. */
export const MODES_AUDIENCE = [
  "MES_CONTACTS",
  "MES_CONTACTS_SAUF",
  "PARTAGER_AVEC",
];

/** L'audience d'un compte qui n'a jamais rien réglé. */
export const MODE_PAR_DEFAUT = "MES_CONTACTS";

/**
 * Le lecteur voit-il les statuts de l'auteur ?
 *
 * @param {object} e
 * @param {boolean} e.estAuteur   le lecteur EST l'auteur.
 * @param {boolean} e.estContact  le lecteur a l'auteur dans ses contacts.
 * @param {boolean} e.bloque      l'un des deux a bloqué l'autre, PEU IMPORTE
 *                                LE SENS.
 * @param {string}  e.mode        l'audience choisie par l'auteur.
 * @param {string[]} e.liste      les personnes désignées par l'auteur.
 * @param {string}  e.lecteurId
 * @returns {boolean}
 */
export function peutVoirStatuts({
  estAuteur = false,
  estContact = false,
  bloque = false,
  mode = MODE_PAR_DEFAUT,
  liste = [],
  lecteurId = "",
}) {
  // On voit toujours ses propres statuts — avant toute autre considération :
  // un compte ne peut pas se bloquer, mais il peut figurer dans une liste mal
  // formée, et il doit continuer de se voir.
  if (estAuteur) return true;

  // Le blocage passe AVANT l'audience. Une personne explicitement désignée par
  // « Partager avec… » puis bloquée ne doit plus rien voir : le geste le plus
  // récent et le plus fort l'emporte.
  if (bloque) return false;

  const designe = liste.includes(lecteurId);

  switch (mode) {
    // La liste est une INCLUSION : elle suffit, et elle est seule à décider.
    // Ne pas exiger en plus d'être contact est un choix — l'auteur a nommé
    // quelqu'un, ce geste explicite l'emporte sur l'état du répertoire, qui a
    // pu changer depuis.
    case "PARTAGER_AVEC":
      return designe;

    // La liste est une EXCLUSION, appliquée par-dessus le cercle des contacts.
    case "MES_CONTACTS_SAUF":
      return estContact && !designe;

    // MES_CONTACTS, et tout mode inconnu — un mode illisible en base ne doit
    // jamais ÉLARGIR l'audience, il retombe sur la plus restreinte des deux
    // lectures raisonnables.
    default:
      return estContact;
  }
}

/** Normalise un mode venu de la base ou du réseau. */
export function modeValide(mode) {
  return MODES_AUDIENCE.includes(mode) ? mode : MODE_PAR_DEFAUT;
}

// ---------------------------------------------------------------------------
// CONTRÔLES — `node src/lib/statut-audience.mjs`
// ---------------------------------------------------------------------------

function autoControle() {
  let ok = 0;
  let ko = 0;
  const v = (attendu, cas, nom) => {
    const obtenu = peutVoirStatuts(cas);
    if (obtenu === attendu) {
      ok++;
    } else {
      ko++;
      console.error(`✗ ${nom} — attendu ${attendu}, obtenu ${obtenu}`);
    }
  };

  const A = "auteur";
  const L = "lecteur";

  // --- L'auteur, toujours
  v(true, { estAuteur: true, lecteurId: A }, "l'auteur se voit");
  v(true, { estAuteur: true, bloque: true, lecteurId: A },
    "l'auteur se voit meme avec un blocage incoherent");
  v(true, { estAuteur: true, estContact: false, mode: "PARTAGER_AVEC", liste: [], lecteurId: A },
    "l'auteur se voit meme absent de sa propre liste");

  // --- Le blocage prime
  v(false, { estContact: true, bloque: true, lecteurId: L }, "contact bloque");
  v(false, { estContact: true, bloque: true, mode: "PARTAGER_AVEC", liste: [L], lecteurId: L },
    "designe puis bloque : le blocage l'emporte");
  v(false, { estContact: true, bloque: true, mode: "MES_CONTACTS_SAUF", liste: [], lecteurId: L },
    "bloque, meme hors de la liste d'exclusion");

  // --- MES_CONTACTS
  v(true, { estContact: true, lecteurId: L }, "contact, mode par defaut");
  v(false, { estContact: false, lecteurId: L }, "non-contact, mode par defaut");
  v(true, { estContact: true, mode: "MES_CONTACTS", liste: [L], lecteurId: L },
    "la liste est ignoree en mode MES_CONTACTS");

  // --- MES_CONTACTS_SAUF
  v(true, { estContact: true, mode: "MES_CONTACTS_SAUF", liste: ["autre"], lecteurId: L },
    "contact, exclu quelqu'un d'autre");
  v(false, { estContact: true, mode: "MES_CONTACTS_SAUF", liste: [L], lecteurId: L },
    "contact, mais exclu");
  v(false, { estContact: false, mode: "MES_CONTACTS_SAUF", liste: [], lecteurId: L },
    "non-contact : exclure ne rend pas public");

  // --- PARTAGER_AVEC
  v(true, { estContact: true, mode: "PARTAGER_AVEC", liste: [L], lecteurId: L },
    "designe explicitement");
  v(false, { estContact: true, mode: "PARTAGER_AVEC", liste: ["autre"], lecteurId: L },
    "contact mais non designe : la liste est seule a decider");
  v(true, { estContact: false, mode: "PARTAGER_AVEC", liste: [L], lecteurId: L },
    "designe explicitement, meme hors du repertoire");
  v(false, { estContact: true, mode: "PARTAGER_AVEC", liste: [], lecteurId: L },
    "liste vide : personne ne voit rien");

  // --- Un mode illisible ne doit JAMAIS elargir
  v(false, { estContact: false, mode: "N_IMPORTE_QUOI", liste: [L], lecteurId: L },
    "mode inconnu : ne s'ouvre pas a un non-contact");
  v(true, { estContact: true, mode: "N_IMPORTE_QUOI", liste: [L], lecteurId: L },
    "mode inconnu : retombe sur MES_CONTACTS");

  // --- Normalisation
  if (modeValide("PARTAGER_AVEC") !== "PARTAGER_AVEC") { ko++; console.error("✗ modeValide passe un mode connu"); } else ok++;
  if (modeValide("bidon") !== MODE_PAR_DEFAUT) { ko++; console.error("✗ modeValide replie un mode inconnu"); } else ok++;
  if (modeValide(undefined) !== MODE_PAR_DEFAUT) { ko++; console.error("✗ modeValide replie undefined"); } else ok++;

  console.log(`${ok} contrôles OK, ${ko} en échec`);
  return ko === 0;
}

// Exécuté directement (`node src/lib/statut-audience.mjs`) et non importé.
if (process.argv[1] && process.argv[1].endsWith("statut-audience.mjs")) {
  process.exit(autoControle() ? 0 : 1);
}
