/**
 * LE SEAU ENTREPRISE, ET SES DEUX ESPACES — demande du professeur, 27/10/2026.
 *
 * 🔴 CE QU'IL A DEMANDÉ, EN DEUX LIGNES. Tout ce qui appartient aux entreprises
 * créées depuis l'espace administrateur va dans UN seau à part, et dedans il n'y
 * a que DEUX espaces :
 *   · `call-center/` — les audios des centres d'appels. L'espace admin dépose,
 *     l'application lit.
 *   · `archives/`    — le suivi des réclamations : résumés, rapports, pièces
 *     jointes.
 * Tout le reste ne bouge pas : discussions, appels entre employés et photos de
 * profil restent dans le stockage général de l'application.
 *
 * 🔴 R2 N'A PAS DE DOSSIERS, ET C'EST TOUT L'INTÉRÊT DE CE FICHIER. Comme chez
 * S3, un « dossier » n'est qu'un PRÉFIXE dans le nom de l'objet :
 * `call-center/x.mp3` est un fichier dont le nom contient une barre oblique. Il
 * n'y a donc rien à créer, et rien qui empêche une faute de frappe de fabriquer
 * un treizième dossier fantôme. La seule barrière possible est ici : une
 * fonction unique qui construit les noms, et qu'on appelle partout.
 *
 * ⚠️ AUCUNE RÈGLE DE 30 JOURS SUR CE SEAU. Les audios de call center sont de la
 * CONFIGURATION, pas du trafic : une règle de cycle de vie à 30 jours rendrait
 * les standards muets au bout d'un mois. La règle des 30 jours que demande le
 * professeur appartient au seau des médias de discussion, pas à celui-ci.
 */

/** Les deux espaces, et il n'y en aura pas un troisième sans décision. */
export const ESPACE_CALL_CENTER = "call-center";
export const ESPACE_ARCHIVES = "archives";
export const ESPACES = [ESPACE_CALL_CENTER, ESPACE_ARCHIVES];

/**
 * Un morceau de nom propre à mettre dans une adresse.
 *
 * ⚠️ CES NOMS FINISSENT DANS DES URL. Un accent y devient `%C3%A9`, une espace
 * `%20`, et le premier client naïf qui recolle l'adresse à la main se trompe.
 * On réduit donc à l'alphabet sûr, une fois, ici — plutôt que d'espérer que
 * chaque appelant y pense.
 */
export function normaliserMorceau(brut) {
  return String(brut ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // les accents, décomposés puis retirés
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
}

/**
 * Le nom d'un audio de centre d'appels.
 *
 * 🔴 L'IDENTIFIANT D'ENTREPRISE JUSTE APRÈS L'ESPACE, et ce n'est pas
 * cosmétique : deux entreprises ne peuvent plus se télescoper sur un même nom
 * de fichier, et l'on peut effacer ou archiver UNE entreprise d'un seul geste —
 * par son préfixe — sans toucher aux autres.
 */
export function cleCallCenter(idEntreprise, nomFichier) {
  const entreprise = normaliserMorceau(idEntreprise);
  const nom = normaliserMorceau(nomFichier);
  if (!entreprise || !nom) return null;
  return `${ESPACE_CALL_CENTER}/${entreprise}/${nom}`;
}

/**
 * Le nom d'une pièce d'archive : réclamation, rapport, pièce jointe.
 *
 * ⚠️ L'ANNÉE EST DANS LE CHEMIN pour qu'une règle de cycle de vie, si elle
 * arrive un jour, puisse viser une année entière sans lire une base.
 */
export function cleArchive(idEntreprise, annee, idDossier, nomFichier) {
  const entreprise = normaliserMorceau(idEntreprise);
  const dossier = normaliserMorceau(idDossier);
  const nom = normaliserMorceau(nomFichier);
  const an = Number.parseInt(annee, 10);
  if (!entreprise || !dossier || !nom) return null;
  if (!Number.isInteger(an) || an < 2000 || an > 2999) return null;
  return `${ESPACE_ARCHIVES}/${entreprise}/${an}/${dossier}/${nom}`;
}

/** L'entreprise à qui appartient ce nom d'objet, ou `null` s'il n'est pas des nôtres. */
export function entrepriseDepuisCle(cle) {
  const m = /^(call-center|archives)\/([^/]+)\//.exec(String(cle ?? ""));
  return m ? m[2] : null;
}

/** Ce nom tombe-t-il bien dans l'un des deux espaces, et nulle part ailleurs ? */
export function cleAutorisee(cle) {
  return ESPACES.some((e) => String(cle ?? "").startsWith(`${e}/`));
}
