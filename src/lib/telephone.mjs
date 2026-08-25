/**
 * Numéros de téléphone : normalisation et présentation, selon le pays.
 *
 * POURQUOI ICI : trois clients parlent à ce backend, et un numéro mal normalisé
 * n'est pas un défaut d'affichage — c'est une ligne en base que plus rien ne
 * rapproche de son propriétaire. Mesuré en production le 25/08/2026 sur les 12
 * comptes qui portent un numéro : certains stockés « 657308298 », d'autres
 * « +237657308299 ». Deux formes pour le même numéro, et la colonne est UNIQUE
 * — la même personne peut donc s'inscrire deux fois, et la recherche par
 * numéro n'en trouve qu'une.
 *
 * ⚠️ Ce fichier n'importe RIEN, volontairement : il s'exécute directement
 * (`node src/lib/telephone.mjs`) et porte ses propres cas de contrôle, comme
 * `message-payload.mjs`.
 *
 * ⚠️ MIROIRS À TENIR ACCORDÉS :
 *   - `alanya/lib/core/telephone.dart`
 *   - `STAGE-WEB/src/services/telephone.ts`
 * Toute évolution se fait ICI d'abord.
 */

/**
 * Groupement des chiffres à l'affichage, par code ISO 3166-1 alpha-2.
 *
 * ⚠️ CE N'EST QUE DE LA PRÉSENTATION. Rien de ce qui est stocké ou comparé n'en
 * dépend : `normaliserTelephone` produit toujours la même chaîne, quels que
 * soient les espaces que l'utilisateur a tapés ou que l'on affiche.
 *
 * La liste est volontairement COURTE — les pays où l'usage local est net et où
 * un mauvais groupement se remarque. Tout le reste tombe sur le défaut par
 * paires, qui est la convention de la majorité des pays servis (Afrique
 * francophone, France) et reste lisible partout ailleurs.
 */
const GROUPES = {
  // Amérique du Nord : 3-3-4, universellement lu ainsi.
  US: [3, 3, 4],
  CA: [3, 3, 4],
  // Royaume-Uni : 4-6 sur les mobiles (07xxx xxxxxx).
  GB: [4, 6],
};

/** Par défaut : des paires. 6 91 23 45 67 se lit sans effort. */
const GROUPE_DEFAUT = 2;

/** Ne garde que les chiffres. */
function chiffres(valeur) {
  return typeof valeur === "string" ? valeur.replace(/\D/g, "") : "";
}

/**
 * La forme CANONIQUE d'un numéro : `+` suivi de l'indicatif et du numéro
 * national, sans espace ni séparateur. C'est CETTE forme qui va en base.
 *
 * Elle absorbe les trois façons dont les gens saisissent leur numéro :
 *
 *   - national, tel qu'on le dicte      : « 6 91 23 45 67 »
 *   - national avec le zéro de service  : « 06 91 23 45 67 »
 *   - international, déjà complet       : « +237 691 23 45 67 » ou « 00237… »
 *
 * ⚠️ LE ZÉRO INITIAL EST RETIRÉ. C'est un préfixe d'acheminement INTERNE au
 * pays : il ne fait pas partie du numéro et n'a aucun sens derrière un
 * indicatif. Le garder produirait « +33 0 6 … », que rien ne peut appeler.
 *
 * ⚠️ L'INDICATIF DÉJÀ PRÉSENT N'EST PAS REDOUBLÉ. Sans ce contrôle, quelqu'un
 * qui colle son numéro international dans un formulaire déjà réglé sur son pays
 * obtient « +237237691… ». C'est l'erreur la plus fréquente sur ce genre de
 * champ, et la plus silencieuse.
 *
 * @param {string} saisie Ce que l'utilisateur a tapé.
 * @param {string} prefixePays L'indicatif du pays choisi, « +237 » par exemple.
 * @returns {string} La forme canonique, ou `""` si la saisie ne donne rien.
 */
export function normaliserTelephone(saisie, prefixePays) {
  let n = chiffres(saisie);
  if (n === "") return "";

  const indicatif = chiffres(prefixePays);

  // « 00 » international : la forme longue de « + ».
  if (n.startsWith("00")) n = n.slice(2);

  // L'indicatif est déjà là — soit collé par l'utilisateur, soit issu d'un
  // « 00 » qu'on vient de retirer.
  if (indicatif !== "" && n.startsWith(indicatif)) {
    n = n.slice(indicatif.length);
  }

  // Le zéro d'acheminement national, une fois l'indicatif écarté.
  n = n.replace(/^0+/, "");

  if (n === "") return "";
  return indicatif === "" ? `+${n}` : `+${indicatif}${n}`;
}

/**
 * Le numéro tel qu'on le LIT, groupé selon l'usage du pays.
 *
 * Rend l'indicatif séparé du reste : « +237 6 91 23 45 67 ».
 *
 * @param {string} saisieOuCanonique Une saisie libre, ou une forme canonique.
 * @param {string} prefixePays L'indicatif du pays choisi.
 * @param {string|null} iso2 Le code pays, pour le groupement local.
 */
export function formaterTelephone(saisieOuCanonique, prefixePays, iso2 = null) {
  const canonique = normaliserTelephone(saisieOuCanonique, prefixePays);
  if (canonique === "") return "";

  const indicatif = chiffres(prefixePays);
  const national = canonique.slice(1 + indicatif.length);
  if (national === "") return `+${indicatif}`;

  const decoupe = GROUPES[(iso2 ?? "").toUpperCase()];
  const morceaux = [];

  if (decoupe) {
    let reste = national;
    for (const taille of decoupe) {
      if (reste === "") break;
      morceaux.push(reste.slice(0, taille));
      reste = reste.slice(taille);
    }
    // Ce qui dépasse le découpage annoncé est conservé, jamais coupé : un
    // numéro plus long qu'attendu reste un numéro, et le tronquer à
    // l'affichage ferait croire à une saisie perdue.
    if (reste !== "") morceaux.push(reste);
  } else {
    /*
     * Paires, en partant de la FIN.
     *
     * ⚠️ Depuis la fin et non depuis le début : les numéros d'Afrique
     * francophone comptent 9 chiffres, un nombre IMPAIR. Grouper depuis le
     * début laisserait un chiffre orphelin à la fin (« 69 12 34 56 7 »),
     * alors que l'usage local isole le premier — « 6 91 23 45 67 », qui est
     * la façon dont ces numéros se dictent.
     */
    let reste = national;
    while (reste.length > GROUPE_DEFAUT) {
      morceaux.unshift(reste.slice(-GROUPE_DEFAUT));
      reste = reste.slice(0, -GROUPE_DEFAUT);
    }
    if (reste !== "") morceaux.unshift(reste);
  }

  return `+${indicatif} ${morceaux.join(" ")}`;
}

/* --------------------------------------------------------------------------
 * Contrôles exécutables : `node src/lib/telephone.mjs`
 * -------------------------------------------------------------------------- */
if (process.argv[1] && process.argv[1].endsWith("telephone.mjs")) {
  let echecs = 0;
  const verifie = (intitule, obtenu, attendu) => {
    const ok = obtenu === attendu;
    if (!ok) echecs++;
    console.log(
      `${ok ? "ok  " : "ÉCHEC"} ${intitule}` +
        (ok ? "" : `\n      obtenu  : ${JSON.stringify(obtenu)}\n      attendu : ${JSON.stringify(attendu)}`),
    );
  };

  // --- Normalisation : les trois façons de saisir le MÊME numéro ------------
  const attendu237 = "+237691234567";
  verifie("national, dicté", normaliserTelephone("6 91 23 45 67", "+237"), attendu237);
  verifie("national, collé", normaliserTelephone("691234567", "+237"), attendu237);
  verifie("avec le zéro de service", normaliserTelephone("0691234567", "+237"), attendu237);
  verifie("déjà international", normaliserTelephone("+237 691 23 45 67", "+237"), attendu237);
  verifie("international en 00", normaliserTelephone("00237691234567", "+237"), attendu237);
  /*
   * ⚠️ L'INDICATIF N'EST RETIRÉ QU'UNE FOIS, jamais en boucle — et ce cas est
   * là pour le figer.
   *
   * Le retirer tant qu'il se présente semblerait plus robuste, mais mutilerait
   * des numéros légitimes : rien n'interdit à un numéro national de commencer
   * par les chiffres de son propre indicatif, et on ne peut pas distinguer les
   * deux. Une saisie déjà internationale est traitée correctement (cas
   * « déjà international » ci-dessus) ; une chaîne où l'indicatif apparaît
   * DEUX fois est ambiguë, et on préfère la laisser telle quelle plutôt que de
   * deviner — l'utilisateur voit alors un numéro visiblement faux et le
   * corrige, au lieu d'un numéro plausible mais amputé.
   */
  verifie(
    "indicatif redoublé : laissé tel quel, pas deviné",
    normaliserTelephone("+237237691234567", "+237"),
    "+237237691234567",
  );
  verifie("saisie vide", normaliserTelephone("", "+237"), "");
  verifie("que des séparateurs", normaliserTelephone("  -- ", "+237"), "");
  verifie("que des zéros", normaliserTelephone("000", "+237"), "");
  verifie("sans indicatif de pays", normaliserTelephone("0691234567", ""), "+691234567");

  // --- Présentation --------------------------------------------------------
  verifie("Cameroun : paires depuis la fin", formaterTelephone("691234567", "+237", "CM"), "+237 6 91 23 45 67");
  verifie("France : 9 chiffres, même règle", formaterTelephone("0612345678", "+33", "FR"), "+33 6 12 34 56 78");
  verifie("États-Unis : 3-3-4", formaterTelephone("4155552671", "+1", "US"), "+1 415 555 2671");
  verifie("Canada : 3-3-4 aussi", formaterTelephone("4165551234", "+1", "CA"), "+1 416 555 1234");
  verifie("Royaume-Uni : 4-6", formaterTelephone("07700900123", "+44", "GB"), "+44 7700 900123");
  verifie("pays inconnu → paires", formaterTelephone("771234567", "+221", "SN"), "+221 7 71 23 45 67");
  verifie("iso2 absent → paires", formaterTelephone("771234567", "+221", null), "+221 7 71 23 45 67");
  verifie("plus long qu'annoncé : rien n'est coupé", formaterTelephone("41555526719", "+1", "US"), "+1 415 555 2671 9");
  verifie("vide reste vide", formaterTelephone("", "+237", "CM"), "");

  // --- La propriété qui compte : formater ne change JAMAIS ce qu'on stocke --
  const saisies = ["6 91 23 45 67", "0691234567", "+237691234567", "00237691234567"];
  const canoniques = new Set(saisies.map((s) => normaliserTelephone(s, "+237")));
  verifie("quatre saisies → UNE seule forme en base", canoniques.size, 1);
  verifie(
    "reformater une forme déjà canonique ne la change pas",
    normaliserTelephone(formaterTelephone(attendu237, "+237", "CM"), "+237"),
    attendu237,
  );

  console.log(echecs === 0 ? "\nTous les contrôles passent." : `\n${echecs} ÉCHEC(S).`);
  process.exit(echecs === 0 ? 0 : 1);
}
