/**
 * Registre des moteurs de traduction servis par le relais.
 *
 * POURQUOI CE FICHIER. Le relais ne servait qu'Azure, choisi par une variable
 * d'environnement. L'utilisateur veut choisir son moteur depuis les Parametres,
 * avec le prix devant chaque choix. Deux besoins en decoulent :
 *  - un adaptateur par fournisseur, tous de meme signature, pour que la route
 *    ne connaisse aucun format de requete particulier ;
 *  - une description lisible par le client (disponibilite + prix), pour que les
 *    Parametres n'affichent jamais une option qui echouera.
 *
 * Le prix vit ICI et non dans le web : le corriger est un changement de
 * variable d'environnement, pas un redeploiement du client.
 *
 * -------------------------------------------------------------------------
 * VARIABLES D'ENVIRONNEMENT
 * -------------------------------------------------------------------------
 * Choix du fournisseur
 *   TRANSLATE_PROVIDER          Fournisseur utilise quand la requete n'en
 *                               nomme aucun (compatibilite avec les clients
 *                               deja deployes). A defaut : le moins couteux
 *                               parmi ceux reellement configures.
 *   TRANSLATE_QUOTA_JOUR        Caracteres par compte et par jour (50000).
 *
 * Azure AI Translator
 *   AZURE_TRANSLATOR_KEY        Obligatoire pour activer le fournisseur.
 *   AZURE_TRANSLATOR_REGION     Region de la ressource, si elle est regionale.
 *   AZURE_TRANSLATOR_ENDPOINT   Defaut https://api.cognitive.microsofttranslator.com
 *
 * Google Cloud Translation v2
 *   GOOGLE_TRANSLATE_KEY        Cle d'API. Obligatoire pour activer.
 *   GOOGLE_TRANSLATE_ENDPOINT   Defaut https://translation.googleapis.com
 *
 * DeepL
 *   DEEPL_AUTH_KEY              Cle d'authentification. Obligatoire pour activer.
 *   DEEPL_ENDPOINT              Force l'hote. Sinon deduit de la cle : une cle
 *                               suffixee « :fx » est une cle gratuite et vise
 *                               api-free.deepl.com, les autres api.deepl.com.
 *
 * LibreTranslate (auto-heberge)
 *   LIBRETRANSLATE_URL          Racine de l'instance. Obligatoire pour activer.
 *   LIBRETRANSLATE_API_KEY      Si l'instance en exige une.
 *
 * Prix affiches, en dollars par million de caracteres. Chacun remplace le
 * tarif public constate ; mettre 0 pour annoncer la gratuite.
 *   TRANSLATE_PRIX_AZURE          (10)
 *   TRANSLATE_PRIX_GOOGLE         (20)
 *   TRANSLATE_PRIX_DEEPL          (27.5)
 *   TRANSLATE_PRIX_LIBRETRANSLATE (0)
 */

/** Coupe court a un fournisseur qui ne repond plus, plutot que de tenir la requete. */
const DELAI_APPEL_MS = 15_000;

export type CodeFournisseur = "navigateur" | "azure" | "google" | "deepl" | "libretranslate";

export interface TraductionUnitaire {
  texte: string;
  /** Langue source, celle declaree par l'appelant ou celle detectee par le moteur. */
  source: string;
}

/**
 * Signature commune a tous les adaptateurs. Un lot, une langue cible, une
 * langue source facultative ; en retour, un resultat par texte, dans l'ordre.
 */
export type Adaptateur = (
  textes: string[],
  cible: string,
  source?: string,
) => Promise<TraductionUnitaire[]>;

interface Fournisseur {
  id: CodeFournisseur;
  /**
   * Vrai quand le moteur tourne sur l'appareil de l'utilisateur. Le relais ne
   * l'appelle jamais : il ne figure ici que pour que les Parametres recoivent
   * une liste complete, prix compris, depuis une seule source.
   */
  surAppareil: boolean;
  /** Dollars par million de caracteres, avant substitution par l'environnement. */
  prixDefaut: number;
  /** Variable d'environnement qui remplace le prix ci-dessus. */
  varPrix: string;
  /** Les cles necessaires sont-elles presentes ? */
  configure: () => boolean;
  /** Traduit un code de langue de l'application vers celui du fournisseur. */
  langue: (code: string) => string;
  /** Chemin inverse : le code rendu par le fournisseur, ramene a l'application. */
  codeApplication: (code: string) => string;
  traduire?: Adaptateur;
}

/* ------------------------------------------------------- Codes de langue */

/**
 * Les fournisseurs ne parlent pas le meme dialecte de codes. Ces tables ne
 * listent que les ECARTS ; tout code absent passe tel quel. Une liste blanche
 * complete serait fausse dans six mois : le fournisseur reste seul juge de ce
 * qu'il sait traduire, et repond par une erreur si le code lui est inconnu.
 *
 * Les ecarts ci-dessous sont releves sur les listes vivantes des fournisseurs,
 * pas devines : « zh » et « no » ne sont PAS des codes Azure ni LibreTranslate,
 * un appel qui les envoie tels quels echoue.
 */
const ECARTS_AZURE: Record<string, string> = { zh: "zh-Hans", no: "nb" };
const ECARTS_GOOGLE: Record<string, string> = { zh: "zh-CN" };
const ECARTS_LIBRE: Record<string, string> = { zh: "zh-Hans", no: "nb" };
/** DeepL attend ses codes en majuscules, et nomme le norvegien « NB ». */
const ECARTS_DEEPL: Record<string, string> = { no: "NB" };

function ecart(table: Record<string, string>, code: string): string {
  return table[code] ?? code;
}

/**
 * Chemin inverse, applique a la langue DETECTEE par un moteur.
 *
 * Sans lui, le relais rendrait « zh-Hans » ou « NB » a un client qui ne connait
 * que « zh » et « no ». L'entree et la sortie de l'API parlent donc les memes
 * codes, quel que soit le moteur qui a servi — c'est ce qui permet de changer
 * de moteur sans que rien d'autre ne bouge.
 */
function ecartInverse(table: Record<string, string>, code: string): string {
  const bas = code.toLowerCase();
  for (const [application, chezLeFournisseur] of Object.entries(table)) {
    if (chezLeFournisseur.toLowerCase() === bas) return application;
  }
  // A defaut, on laisse tomber la sous-etiquette regionale : « pt-PT » vaut
  // « pt » pour l'application, qui ne distingue pas les variantes.
  return bas.split("-")[0];
}

/**
 * Un code de langue plausible : deux a huit lettres, eventuellement suivies
 * d'un tiret et d'une sous-etiquette. Sert a refuser une entree fantaisiste
 * avant d'en faire une requete sortante, pas a juger du catalogue d'un moteur.
 */
export function codeLangueValide(code: string): boolean {
  return /^[a-z]{2,8}(-[a-z0-9]{2,8})?$/i.test(code);
}

/* ------------------------------------------------------------ Adaptateurs */

/** Enveloppe commune : delai maximal, et jamais le corps d'erreur du fournisseur. */
async function appeler(id: string, url: string, init: RequestInit): Promise<Response> {
  const reponse = await fetch(url, { ...init, signal: AbortSignal.timeout(DELAI_APPEL_MS) });
  if (!reponse.ok) {
    // Le corps d'une erreur de fournisseur contient souvent le texte envoye.
    // Cette exception remonte jusqu'a une reponse destinee au client : elle ne
    // doit porter que le nom du moteur et le code HTTP.
    throw new Error(`${id} ${reponse.status}`);
  }
  return reponse;
}

const AZURE_URL =
  process.env.AZURE_TRANSLATOR_ENDPOINT ?? "https://api.cognitive.microsofttranslator.com";

/** Azure AI Translator. Un seul aller-retour pour tout le lot. */
const traduireAzure: Adaptateur = async (textes, cible, source) => {
  const url = new URL("/translate", AZURE_URL);
  url.searchParams.set("api-version", "3.0");
  url.searchParams.set("to", cible);
  if (source) url.searchParams.set("from", source);
  // Les messages sont du texte, jamais du balisage : le dire evite qu'Azure
  // interprete un chevron comme une balise et le mange.
  url.searchParams.set("textType", "plain");

  const region = process.env.AZURE_TRANSLATOR_REGION ?? "";
  const reponse = await appeler("azure", url.toString(), {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": process.env.AZURE_TRANSLATOR_KEY ?? "",
      ...(region ? { "Ocp-Apim-Subscription-Region": region } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(textes.map((texte) => ({ Text: texte }))),
  });

  const donnees = (await reponse.json()) as Array<{
    detectedLanguage?: { language: string };
    translations?: Array<{ text: string }>;
  }>;
  return textes.map((_, index) => ({
    texte: donnees[index]?.translations?.[0]?.text ?? "",
    source: source ?? donnees[index]?.detectedLanguage?.language ?? "",
  }));
};

const GOOGLE_URL = process.env.GOOGLE_TRANSLATE_ENDPOINT ?? "https://translation.googleapis.com";

/**
 * Google rend du texte echappe en entites HTML meme avec format=text : une
 * apostrophe revient en « &#39; ». Sans ce decodage, l'utilisateur lirait le
 * code de l'entite dans sa bulle.
 */
function decoderEntites(texte: string): string {
  return texte
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // L'esperluette en dernier, sinon elle re-decode ce qui vient d'etre ecrit.
    .replace(/&amp;/g, "&");
}

/** Google Cloud Translation v2. La cle voyage en parametre, comme l'exige l'API. */
const traduireGoogle: Adaptateur = async (textes, cible, source) => {
  const url = new URL("/language/translate/v2", GOOGLE_URL);
  url.searchParams.set("key", process.env.GOOGLE_TRANSLATE_KEY ?? "");

  const reponse = await appeler("google", url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: textes,
      target: cible,
      ...(source ? { source } : {}),
      format: "text",
    }),
  });

  const donnees = (await reponse.json()) as {
    data?: { translations?: Array<{ translatedText?: string; detectedSourceLanguage?: string }> };
  };
  const traductions = donnees.data?.translations ?? [];
  return textes.map((_, index) => ({
    texte: decoderEntites(traductions[index]?.translatedText ?? ""),
    source: source ?? traductions[index]?.detectedSourceLanguage ?? "",
  }));
};

/**
 * DeepL separe ses deux offres par l'hote, et la cle dit laquelle : une cle
 * gratuite se termine par « :fx ». Se tromper d'hote donne un 403 opaque, d'ou
 * cette deduction plutot qu'une variable de plus a tenir a jour.
 */
function hoteDeepl(cle: string): string {
  if (process.env.DEEPL_ENDPOINT) return process.env.DEEPL_ENDPOINT;
  return cle.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
}

/** DeepL. Codes de langue en majuscules, texte en tableau, ordre preserve. */
const traduireDeepl: Adaptateur = async (textes, cible, source) => {
  const cle = process.env.DEEPL_AUTH_KEY ?? "";
  const reponse = await appeler("deepl", `${hoteDeepl(cle)}/v2/translate`, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${cle}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: textes,
      target_lang: cible,
      ...(source ? { source_lang: source } : {}),
    }),
  });

  const donnees = (await reponse.json()) as {
    translations?: Array<{ text?: string; detected_source_language?: string }>;
  };
  const traductions = donnees.translations ?? [];
  return textes.map((_, index) => ({
    texte: traductions[index]?.text ?? "",
    source: source ?? traductions[index]?.detected_source_language?.toLowerCase() ?? "",
  }));
};

/**
 * LibreTranslate. « source » y est obligatoire : « auto » quand l'appelant ne
 * l'a pas declaree. Avec un tableau en entree, translatedText et
 * detectedLanguage reviennent eux aussi en tableaux.
 */
const traduireLibre: Adaptateur = async (textes, cible, source) => {
  const racine = (process.env.LIBRETRANSLATE_URL ?? "").replace(/\/+$/, "");
  const cle = process.env.LIBRETRANSLATE_API_KEY ?? "";

  const reponse = await appeler("libretranslate", `${racine}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: textes,
      source: source ?? "auto",
      target: cible,
      format: "text",
      ...(cle ? { api_key: cle } : {}),
    }),
  });

  const donnees = (await reponse.json()) as {
    translatedText?: string | string[];
    detectedLanguage?: { language?: string } | Array<{ language?: string }>;
  };
  // Une instance peut repondre au singulier meme sur un lot d'un seul element :
  // on ramene les deux formes au tableau plutot que de supposer.
  const traduits = Array.isArray(donnees.translatedText)
    ? donnees.translatedText
    : donnees.translatedText !== undefined
      ? [donnees.translatedText]
      : [];
  const detectees = Array.isArray(donnees.detectedLanguage)
    ? donnees.detectedLanguage
    : donnees.detectedLanguage
      ? [donnees.detectedLanguage]
      : [];

  return textes.map((_, index) => ({
    texte: traduits[index] ?? "",
    source: source ?? detectees[index]?.language ?? "",
  }));
};

/* -------------------------------------------------------------- Registre */

const REGISTRE: Record<CodeFournisseur, Fournisseur> = {
  /**
   * Le moteur du navigateur. Gratuit ET rien ne sort de l'appareil : le seul
   * choix qui gagne sur les deux tableaux, donc le defaut. Il est decrit ici
   * pour que les Parametres tiennent leur liste d'une seule source, mais le
   * relais refuse de le servir — c'est le client qui le fait tourner.
   */
  navigateur: {
    id: "navigateur",
    surAppareil: true,
    prixDefaut: 0,
    varPrix: "TRANSLATE_PRIX_NAVIGATEUR",
    configure: () => true,
    langue: (code) => code,
    codeApplication: (code) => code.toLowerCase(),
  },
  azure: {
    id: "azure",
    surAppareil: false,
    prixDefaut: 10,
    varPrix: "TRANSLATE_PRIX_AZURE",
    configure: () => Boolean(process.env.AZURE_TRANSLATOR_KEY),
    langue: (code) => ecart(ECARTS_AZURE, code),
    codeApplication: (code) => ecartInverse(ECARTS_AZURE, code),
    traduire: traduireAzure,
  },
  google: {
    id: "google",
    surAppareil: false,
    prixDefaut: 20,
    varPrix: "TRANSLATE_PRIX_GOOGLE",
    configure: () => Boolean(process.env.GOOGLE_TRANSLATE_KEY),
    langue: (code) => ecart(ECARTS_GOOGLE, code),
    codeApplication: (code) => ecartInverse(ECARTS_GOOGLE, code),
    traduire: traduireGoogle,
  },
  deepl: {
    id: "deepl",
    surAppareil: false,
    prixDefaut: 27.5,
    varPrix: "TRANSLATE_PRIX_DEEPL",
    configure: () => Boolean(process.env.DEEPL_AUTH_KEY),
    langue: (code) => ecart(ECARTS_DEEPL, code).toUpperCase(),
    codeApplication: (code) => ecartInverse(ECARTS_DEEPL, code),
    traduire: traduireDeepl,
  },
  libretranslate: {
    id: "libretranslate",
    surAppareil: false,
    prixDefaut: 0,
    varPrix: "TRANSLATE_PRIX_LIBRETRANSLATE",
    configure: () => Boolean(process.env.LIBRETRANSLATE_URL),
    langue: (code) => ecart(ECARTS_LIBRE, code),
    codeApplication: (code) => ecartInverse(ECARTS_LIBRE, code),
    traduire: traduireLibre,
  },
};

export function fournisseur(id: string): Fournisseur | null {
  return REGISTRE[id as CodeFournisseur] ?? null;
}

/** Prix affiche, en dollars par million de caracteres. */
export function prix(f: Fournisseur): number {
  const brut = process.env[f.varPrix];
  if (!brut) return f.prixDefaut;
  const valeur = Number.parseFloat(brut);
  return Number.isFinite(valeur) && valeur >= 0 ? valeur : f.prixDefaut;
}

export interface FournisseurPublie {
  id: CodeFournisseur;
  surAppareil: boolean;
  gratuit: boolean;
  prixParMillion: number;
  devise: "USD";
}

/**
 * Ce que le client a le droit de proposer, du moins cher au plus cher.
 *
 * Un fournisseur dont la cle manque n'apparait pas : les Parametres ne peuvent
 * donc pas afficher une option qui echouerait au premier message. Aucun
 * libelle n'est renvoye — le web possede son catalogue i18n, le serveur ne
 * possede que le prix.
 */
export function fournisseursDisponibles(): FournisseurPublie[] {
  return Object.values(REGISTRE)
    .filter((f) => f.configure())
    .map((f) => {
      const montant = prix(f);
      return {
        id: f.id,
        surAppareil: f.surAppareil,
        gratuit: montant === 0,
        prixParMillion: montant,
        devise: "USD" as const,
      };
    })
    .sort(
      (a, b) =>
        a.prixParMillion - b.prixParMillion ||
        // A prix egal, le moteur de l'appareil passe devant : il est le seul a
        // ne rien laisser sortir, et la liste se rend alors telle quelle, le
        // defaut en tete.
        Number(b.surAppareil) - Number(a.surAppareil) ||
        a.id.localeCompare(b.id),
    );
}

/**
 * Fournisseur distant utilise quand la requete n'en nomme aucun.
 *
 * TRANSLATE_PROVIDER garde la main, ce qui laisse intact le comportement des
 * clients deja deployes. A defaut, le moins couteux de ceux qui sont
 * configures : le meme principe que le defaut cote client, applique ici.
 */
export function fournisseurParDefaut(): Fournisseur | null {
  const nomme = process.env.TRANSLATE_PROVIDER;
  if (nomme) {
    const f = fournisseur(nomme.trim().toLowerCase());
    if (f && !f.surAppareil && f.configure()) return f;
    return null;
  }
  const distants = Object.values(REGISTRE)
    .filter((f) => !f.surAppareil && f.configure())
    .sort((a, b) => prix(a) - prix(b) || a.id.localeCompare(b.id));
  return distants[0] ?? null;
}

export type { Fournisseur };
