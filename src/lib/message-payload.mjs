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

  console.log(echecs === 0 ? "\nTous les contrôles passent." : `\n${echecs} contrôle(s) en échec.`);
  process.exitCode = echecs === 0 ? 0 : 1;
}
