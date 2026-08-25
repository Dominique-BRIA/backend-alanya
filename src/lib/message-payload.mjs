/**
 * Charges utiles des messages CONTACT et LOCATION.
 *
 * POURQUOI ICI : trois clients parlent à ce backend (Flutter, React, et
 * l'application de l'équipe). Une règle de format décidée dans un seul d'entre
 * eux se désaccorde silencieusement — c'est exactement ce qui a bloqué les
 * appels Web → Android pendant des jours (règle d'offreur WebRTC changée d'un
 * seul côté). Le format vit donc au SEUL endroit que les trois traversent, et
 * le serveur refuse ce qui ne s'y conforme pas : une charge invalide est
 * rejetée à l'entrée plutôt qu'enregistrée pour toujours.
 *
 * POURQUOI DANS `content` ET PAS EN COLONNES : `message` est une table du
 * référentiel de l'équipe. Y ajouter des colonnes de latitude ou de nom de
 * contact créerait des écarts à défendre à chaque harmonisation, alors que
 * `content` existe déjà, est nullable, et n'est plus qu'un texte libre pour
 * tous les types non TEXT.
 *
 * FORMAT (clés en anglais, comme le reste du protocole — `mimeType`,
 * `senderId`, `convId`) :
 *
 *   CONTACT  {"v":1,"contacts":[{"name":"Jean Dupont",
 *                               "phones":["+237691234567"],
 *                               "alanyaId":"12345678",
 *                               "avatarUrl":"https://…"}]}
 *
 *   LOCATION {"v":1,"location":{"lat":3.848,"lng":11.502,
 *                               "accuracy":12.5,"label":"Douala"}}
 *
 * `alanyaId` et `avatarUrl` sont facultatifs : un contact du répertoire
 * téléphonique n'a pas de compte Alanya. La PHOTO d'un tel contact ne va JAMAIS
 * dans cette charge — elle est envoyée comme média du message (`media[0]`), la
 * chaîne d'upload existant déjà et `content` étant plafonné à 8000 caractères
 * par la validation.
 *
 * ⚠️ Ce fichier n'importe RIEN, volontairement : il s'exécute directement
 * (`node src/lib/message-payload.mjs`) et porte ses propres cas de contrôle,
 * au lieu d'être seulement relu.
 */

/** Types dont la charge vit dans `content` et qui n'exigent aucun média. */
export const TYPES_STRUCTURES = new Set(["CONTACT", "LOCATION"]);

/** Version courante de la charge. Un client plus ancien lira `v` et saura. */
export const VERSION_CHARGE = 1;

function litJson(content) {
  if (typeof content !== "string" || content.length === 0) return null;
  try {
    const valeur = JSON.parse(content);
    return valeur !== null && typeof valeur === "object" ? valeur : null;
  } catch {
    return null;
  }
}

function texteNettoye(valeur, maxi) {
  if (typeof valeur !== "string") return null;
  const t = valeur.trim();
  if (t.length === 0) return null;
  return t.slice(0, maxi);
}

/**
 * Contacts portés par un message CONTACT, ou `null` si la charge est invalide.
 *
 * Un contact sans nom ET sans numéro n'est rien d'affichable : il est écarté.
 * Un nom seul est accepté (un contact du répertoire peut n'avoir qu'un e-mail),
 * un numéro seul aussi (l'app affiche alors le numéro comme titre).
 */
export function litContacts(content) {
  const charge = litJson(content);
  const brut = charge?.contacts;
  if (!Array.isArray(brut) || brut.length === 0) return null;

  const contacts = [];
  for (const c of brut) {
    if (c === null || typeof c !== "object") continue;
    const name = texteNettoye(c.name, 200);
    const phones = Array.isArray(c.phones)
      ? c.phones.map((p) => texteNettoye(p, 40)).filter((p) => p !== null).slice(0, 10)
      : [];
    if (name === null && phones.length === 0) continue;
    contacts.push({
      name,
      phones,
      alanyaId: texteNettoye(c.alanyaId, 10),
      avatarUrl: texteNettoye(c.avatarUrl, 500),
    });
  }
  // Plafond aligné sur celui des médias (10) : au-delà, la carte n'est plus
  // lisible et le libellé de la liste de conversations n'a plus de sens.
  return contacts.length > 0 ? contacts.slice(0, 10) : null;
}

/**
 * Position portée par un message LOCATION, ou `null` si la charge est invalide.
 *
 * ⚠️ Les bornes ne sont pas décoratives : une longitude de 200 ou un `NaN`
 * arrivé d'un client mal réglé produirait une carte vide chez le destinataire,
 * sans que rien ne dise d'où vient le problème.
 */
export function litPosition(content) {
  const charge = litJson(content);
  const brut = charge?.location;
  if (brut === null || typeof brut !== "object") return null;

  const lat = Number(brut.lat);
  const lng = Number(brut.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const accuracy = Number(brut.accuracy);
  return {
    lat,
    lng,
    accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
    label: texteNettoye(brut.label, 200),
  };
}

/**
 * Vrai si `content` est une charge valide pour ce `type`.
 *
 * Les types non structurés renvoient vrai : cette fonction ne juge que ce
 * qu'elle connaît, elle n'est pas un contrôle général de message.
 */
export function chargeValide(type, content) {
  if (type === "CONTACT") return litContacts(content) !== null;
  if (type === "LOCATION") return litPosition(content) !== null;
  return true;
}

/**
 * Libellé lisible d'un message structuré, pour la liste de conversations
 * (`conversation.lastMessage`) et le corps de la notification push.
 *
 * ⚠️ C'est ce qui empêche du JSON brut de s'afficher dans TOUS les clients.
 * `lastMessage` est dénormalisé en base et lu directement par l'application de
 * l'équipe et par le web : y écrire la charge telle quelle afficherait
 * `{"v":1,"contacts":[…]}` sous le nom du correspondant. Le libellé est donc
 * calculé à l'écriture, une fois, côté serveur.
 *
 * Renvoie `null` pour tout type non structuré — l'appelant garde alors son
 * comportement d'origine.
 */
export function apercuStructure(type, content) {
  if (type === "CONTACT") {
    const contacts = litContacts(content);
    if (contacts === null) return "👤 Contact";
    const premier = contacts[0].name ?? contacts[0].phones[0] ?? "Contact";
    if (contacts.length === 1) return `👤 ${premier}`;
    return `👤 ${premier} et ${contacts.length - 1} autre${contacts.length > 2 ? "s" : ""}`;
  }
  if (type === "LOCATION") {
    const position = litPosition(content);
    if (position === null) return "📍 Position";
    return position.label !== null ? `📍 ${position.label}` : "📍 Position partagée";
  }
  return null;
}

/**
 * Le libellé d'UNE LIGNE d'un message, quel que soit son type.
 *
 * 🔴 CORRIGE UN DÉFAUT DE PRODUCTION (18/08/2026) : la colonne
 * `conversation.lastMessage` valait **NULL** pour tout média SANS LÉGENDE.
 * [apercuStructure] ne connaît que CONTACT et LOCATION, et les sites d'écriture
 * repliaient sur `content`, vide dans ce cas. Mesuré en prod avant correction :
 * 6 conversations sur 94 — 3 photos, 1 vidéo, 1 vocal, 1 fichier — toutes avec
 * la colonne à NULL, contre 0 sur les 84 conversations en TEXT.
 *
 * Conséquence visible, signalée par le user : `GET /api/conversations` rend
 * alors `lastMessage: null`, et le client fait gagner l'aperçu du dernier APPEL
 * — « j'envoie une photo, la liste affiche l'état du dernier appel ».
 *
 * ⚠️ MIROIR EXACT de `apercuMessage` dans `alanya/lib/models/message_payload.dart`,
 * et c'est ici que la règle est décidée : la colonne est lue TELLE QUELLE par
 * les trois clients, y compris l'application de l'équipe qu'on ne recompile pas.
 * Un libellé calculé côté client n'aurait corrigé qu'un client sur trois.
 *
 * `nomFichier` vient du média, que la charge utile ne porte pas.
 *
 * ⚠️ LES TYPES SONT ANNOTÉS, et ce n'est pas de la décoration : sans eux,
 * TypeScript infère `nomFichier` depuis sa seule valeur par défaut et en déduit
 * `null | undefined`. Le paramètre devenait donc impossible à renseigner depuis
 * un appelant `.ts` — aucun ne le faisait, personne ne l'avait vu, et le premier
 * qui a voulu nommer un fichier s'est fait refuser au build.
 *
 * @param {string} type
 * @param {string|null|undefined} content
 * @param {string|null} [nomFichier]
 * @returns {string|null}
 */
export function apercuMessage(type, content, nomFichier = null) {
  const structure = apercuStructure(type, content);
  if (structure !== null) return structure;

  // `""` et `null` disent la même chose — « pas de texte ». Les distinguer
  // était précisément le défaut : un média sans légende tombait entre les deux.
  const texte = typeof content === "string" ? content.trim() : "";

  switch (type) {
    case "IMAGE":
      return texte === "" ? "📷 Photo" : `📷 ${texte}`;
    case "VIDEO":
      return texte === "" ? "🎥 Vidéo" : `🎥 ${texte}`;
    case "AUDIO":
      return "🎤 Message vocal";
    case "FILE": {
      const nom = typeof nomFichier === "string" ? nomFichier.trim() : "";
      if (nom !== "") return `📎 ${nom}`;
      return texte === "" ? "📎 Fichier" : `📎 ${texte}`;
    }
    default:
      // TEXT et tout type à venir. `null` et non `""` : la colonne est
      // nullable, et une chaîne vide n'aurait pas le même sens pour les
      // clients qui testent son absence.
      return texte === "" ? null : texte;
  }
}

/**
 * Longueur maximale de `message.content`, en caractères.
 *
 * 🔴 C'EST UNE CONTRAINTE DE BASE, pas une préférence : depuis le 25/08/2026 la
 * colonne est un `VARCHAR(500)` et non plus un `TEXT`
 * (`prisma/manual/2026-08_message_content_varchar500.sql`).
 *
 * ⚠️ POSTGRESQL REFUSE, IL NE COUPE PAS. Une valeur de 501 caractères ne rentre
 * pas « tronquée » : l'INSERT échoue avec l'erreur 22001, et le message est
 * perdu au lieu d'être raccourci. C'est toute la raison d'être de
 * [tronqueContenu] — sans elle, passer la colonne en VARCHAR aurait transformé
 * chaque message long en échec d'envoi.
 */
export const LONGUEUR_MAX_CONTENU = 500;

/**
 * Ramène `content` à ce que la colonne accepte, AVANT toute écriture.
 *
 * Deux comportements, et la différence n'est pas cosmétique :
 *
 * - **Texte et légendes** : coupés à [LONGUEUR_MAX_CONTENU]. On perd la fin
 *   d'un message très long, ce qui est le compromis accepté ; on ne perd jamais
 *   le message.
 *
 * - **CONTACT et LOCATION** : JAMAIS coupés, REFUSÉS quand ils dépassent. Leur
 *   `content` est du JSON (voir l'en-tête de ce fichier) : le couper produit une
 *   chaîne que `JSON.parse` rejette, donc une ligne que plus AUCUN client ne
 *   sait afficher — ni aujourd'hui ni jamais, l'information étant détruite en
 *   base. Un refus est visible tout de suite par l'expéditeur ; une charge
 *   mutilée ne se découvre que chez le destinataire, longtemps après. C'est le
 *   même raisonnement que le refus d'une charge invalide dans `chargeValide`.
 *
 * @param {string} type
 * @param {string|null|undefined} content
 * @returns {{contenu: string|null, refuse: boolean}} `refuse` vaut vrai
 *   uniquement pour une charge structurée trop longue — l'appelant doit alors
 *   répondre une erreur et ne rien écrire.
 */
export function tronqueContenu(type, content) {
  if (typeof content !== "string") return { contenu: null, refuse: false };

  if (TYPES_STRUCTURES.has(type)) {
    return content.length > LONGUEUR_MAX_CONTENU
      ? { contenu: null, refuse: true }
      : { contenu: content, refuse: false };
  }

  return { contenu: content.slice(0, LONGUEUR_MAX_CONTENU), refuse: false };
}

/* --------------------------------------------------------------------------
 * Contrôles exécutables : `node src/lib/message-payload.mjs`
 *
 * Le fichier n'a aucune dépendance, donc ces cas tournent vraiment — c'est la
 * seule façon de prouver une règle de format autrement que par relecture.
 * -------------------------------------------------------------------------- */
if (process.argv[1] && process.argv[1].endsWith("message-payload.mjs")) {
  let echecs = 0;
  const verifie = (intitule, obtenu, attendu) => {
    const ok = JSON.stringify(obtenu) === JSON.stringify(attendu);
    if (!ok) echecs++;
    console.log(`${ok ? "ok  " : "ÉCHEC"} ${intitule}${ok ? "" : `\n      obtenu  : ${JSON.stringify(obtenu)}\n      attendu : ${JSON.stringify(attendu)}`}`);
  };

  const contactSimple = JSON.stringify({
    v: 1,
    contacts: [{ name: "Jean Dupont", phones: ["+237691234567"], alanyaId: "12345678" }],
  });
  verifie("contact simple → 1 entrée", litContacts(contactSimple)?.length, 1);
  verifie("contact simple → libellé", apercuStructure("CONTACT", contactSimple), "👤 Jean Dupont");
  verifie(
    "trois contacts → « et 2 autres »",
    apercuStructure(
      "CONTACT",
      JSON.stringify({ v: 1, contacts: [{ name: "A" }, { name: "B" }, { name: "C" }] }),
    ),
    "👤 A et 2 autres",
  );
  verifie(
    "deux contacts → « et 1 autre » (singulier)",
    apercuStructure("CONTACT", JSON.stringify({ v: 1, contacts: [{ name: "A" }, { name: "B" }] })),
    "👤 A et 1 autre",
  );
  verifie(
    "contact sans nom → le numéro fait titre",
    apercuStructure("CONTACT", JSON.stringify({ v: 1, contacts: [{ phones: ["690000000"] }] })),
    "👤 690000000",
  );
  verifie("contact vide → refusé", litContacts(JSON.stringify({ v: 1, contacts: [{}] })), null);
  verifie("liste vide → refusée", litContacts(JSON.stringify({ v: 1, contacts: [] })), null);
  verifie("JSON invalide → refusé", litContacts("pas du json"), null);
  verifie("texte ordinaire → refusé", chargeValide("CONTACT", "Salut, voici mon numéro"), false);

  const position = JSON.stringify({ v: 1, location: { lat: 3.848, lng: 11.502, accuracy: 12.5 } });
  verifie("position → lue", litPosition(position), { lat: 3.848, lng: 11.502, accuracy: 12.5, label: null });
  verifie("position → libellé", apercuStructure("LOCATION", position), "📍 Position partagée");
  verifie(
    "position nommée → libellé nommé",
    apercuStructure("LOCATION", JSON.stringify({ v: 1, location: { lat: 0, lng: 0, label: "Douala" } })),
    "📍 Douala",
  );
  verifie("lat 0 / lng 0 → acceptée (golfe de Guinée)", chargeValide("LOCATION", JSON.stringify({ v: 1, location: { lat: 0, lng: 0 } })), true);
  verifie("longitude 200 → refusée", litPosition(JSON.stringify({ v: 1, location: { lat: 3, lng: 200 } })), null);
  verifie("lat non numérique → refusée", litPosition(JSON.stringify({ v: 1, location: { lat: "ici", lng: 11 } })), null);
  verifie("charge de contact sur un LOCATION → refusée", chargeValide("LOCATION", contactSimple), false);
  verifie("type non structuré → toujours valide", chargeValide("IMAGE", null), true);
  verifie("libellé d'un type non structuré → null", apercuStructure("IMAGE", null), null);

  // --- apercuMessage : le défaut « la liste affiche le dernier appel » -------
  //
  // Le cas qui comptait est le média SANS légende : il rendait `null`, la route
  // des conversations renvoyait `lastMessage: null`, et le client basculait sur
  // l'aperçu d'appel. Les trois formes du vide sont donc contrôlées séparément.
  verifie("photo sans légende → plus jamais null", apercuMessage("IMAGE", null), "📷 Photo");
  verifie("photo, légende vide → plus jamais null", apercuMessage("IMAGE", ""), "📷 Photo");
  verifie("photo, légende d'espaces → plus jamais null", apercuMessage("IMAGE", "   "), "📷 Photo");
  verifie("photo légendée → la légende", apercuMessage("IMAGE", "au bureau"), "📷 au bureau");
  verifie("vidéo sans légende", apercuMessage("VIDEO", null), "🎥 Vidéo");
  verifie("vocal → libellé fixe", apercuMessage("AUDIO", null), "🎤 Message vocal");
  verifie("document → le NOM du fichier", apercuMessage("FILE", "regarde", "contrat.pdf"), "📎 contrat.pdf");
  verifie("fichier sans nom ni légende", apercuMessage("FILE", null), "📎 Fichier");
  verifie("fichier sans nom, avec légende", apercuMessage("FILE", "le devis"), "📎 le devis");
  // Le TEXTE garde `null` quand il est vide : la colonne est nullable, et une
  // chaîne vide ne veut pas dire la même chose pour les clients.
  verifie("texte → tel quel", apercuMessage("TEXT", "bonjour"), "bonjour");
  verifie("texte vide → null, et non chaîne vide", apercuMessage("TEXT", ""), null);
  // Les deux types structurés continuent de passer par apercuStructure.
  verifie("contact → délégué à apercuStructure", apercuMessage("CONTACT", contactSimple), "👤 Jean Dupont");
  verifie("position → déléguée à apercuStructure", apercuMessage("LOCATION", position), "📍 Position partagée");

  // --- tronqueContenu : la colonne est passée en VARCHAR(500) --------------
  //
  // Le cas qui compte est le 501ᵉ caractère : c'est lui qui faisait échouer
  // l'INSERT en 22001 au lieu de raccourcir. Les bornes sont donc contrôlées
  // une par une, et non « en gros ».
  const court = "a".repeat(LONGUEUR_MAX_CONTENU);
  const long = "a".repeat(LONGUEUR_MAX_CONTENU + 1);
  verifie("texte de 500 → intact", tronqueContenu("TEXT", court).contenu.length, LONGUEUR_MAX_CONTENU);
  verifie("texte de 501 → coupé à 500", tronqueContenu("TEXT", long).contenu.length, LONGUEUR_MAX_CONTENU);
  verifie("texte trop long → jamais refusé", tronqueContenu("TEXT", long).refuse, false);
  verifie("légende de média → coupée comme le texte", tronqueContenu("IMAGE", long).contenu.length, LONGUEUR_MAX_CONTENU);
  verifie("content absent → null, sans refus", tronqueContenu("TEXT", null), { contenu: null, refuse: false });
  // Une charge structurée qui tient est rendue TELLE QUELLE : la couper, même
  // d'un caractère, la rendrait illisible pour toujours.
  verifie("contact qui tient → intact", tronqueContenu("CONTACT", contactSimple).contenu, contactSimple);
  verifie("contact qui tient → non refusé", tronqueContenu("CONTACT", contactSimple).refuse, false);
  verifie("position qui tient → intacte", tronqueContenu("LOCATION", position).contenu, position);
  // Et celle qui ne tient pas est REFUSÉE, jamais mutilée.
  const contactEnorme = JSON.stringify({
    v: 1,
    contacts: Array.from({ length: 10 }, (_, i) => ({
      name: `Contact numero ${i}`,
      phones: ["+237691234567", "+237699887766"],
      avatarUrl: `https://alanyavox.com/api/media/${"0".repeat(40)}${i}`,
    })),
  });
  verifie("charge structurée trop longue → refusée", tronqueContenu("CONTACT", contactEnorme).refuse, true);
  verifie("charge structurée trop longue → rien à écrire", tronqueContenu("CONTACT", contactEnorme).contenu, null);
  // Le témoin doit rester un cas RÉEL : si ce contrôle casse, c'est que la
  // charge fabriquée ci-dessus est passée sous la limite, pas que le code a
  // changé.
  verifie("le témoin dépasse bien 500", contactEnorme.length > LONGUEUR_MAX_CONTENU, true);

  console.log(echecs === 0 ? "\nTous les contrôles passent." : `\n${echecs} contrôle(s) en échec.`);
  process.exitCode = echecs === 0 ? 0 : 1;
}
