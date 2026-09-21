/**
 * BANC D'ESSAI AUTOMATISÉ DU CHIFFREMENT DE BOUT EN BOUT.
 *
 * 🔴 CE SCRIPT JOUE DEUX CLIENTS COMPLETS, pas des requêtes en l'air. Il crée
 * deux comptes, publie leurs clés, ouvre une session X3DH, chiffre, transporte
 * par les vraies routes, déchiffre, et VÉRIFIE que le texte revient identique.
 *
 * ⚠️ POURQUOI UN SCRIPT ET NON DES CLICS DANS UN NAVIGATEUR : un défaut de
 * chiffrement NE SE VOIT PAS à l'écran. Les messages s'affichent de la même
 * façon qu'ils soient correctement chiffrés, mal chiffrés, ou pas chiffrés du
 * tout. Seule une vérification mécanique — le clair revient-il ? le corps
 * transporté est-il vraiment illisible ? — a une valeur ici.
 *
 * Usage : node scripts/e2ee-banc.mjs
 */

import { PrismaClient } from "@prisma/client"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

/*
 * ⚠️ LA BIBLIOTHÈQUE EST CELLE DU CLIENT WEB, prise dans son dépôt. C'est
 * VOULU : tester avec une autre implémentation validerait une compatibilité
 * qu'on n'expédie pas. On veut éprouver exactement ce que le navigateur
 * exécutera.
 */
const CHEMIN_WEB = "../../STAGE-WEB/node_modules/@privacyresearch/libsignal-protocol-typescript"
const signal = require(CHEMIN_WEB)
const {
  KeyHelper,
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
} = signal

const API = process.env.API ?? "http://localhost:3000"
const prisma = new PrismaClient()

/* ══════════════════ OUTILS ══════════════════ */

const b64 = (buf) => Buffer.from(new Uint8Array(buf)).toString("base64")
const deB64 = (s) => {
  const b = Buffer.from(s, "base64")
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}

let echecs = 0
const verifier = (condition, quoi) => {
  if (condition) {
    console.log(`  ✓ ${quoi}`)
  } else {
    echecs++
    console.log(`  ✗ ${quoi}`)
  }
}

async function appel(chemin, { methode = "GET", jeton, corps } = {}) {
  const r = await fetch(`${API}${chemin}`, {
    method: methode,
    headers: {
      ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}),
      ...(corps ? { "Content-Type": "application/json" } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
  })
  const texte = await r.text()
  let charge
  try {
    charge = texte ? JSON.parse(texte) : null
  } catch {
    charge = texte
  }
  if (!r.ok) {
    throw new Error(
      `${methode} ${chemin} → ${r.status} ${JSON.stringify(charge)?.slice(0, 300)}`,
    )
  }
  return charge
}

/* ══════════════════ LE COFFRE, EN MÉMOIRE ══════════════════
 *
 * ⚠️ MÊME CONTRAT QUE `e2ee-store.ts` DU WEB, mais sans `localStorage` : Node
 * n'en a pas. Une `Map` suffit, et le script étant éphémère, la persistance
 * n'apporterait rien — c'est justement ce que le navigateur teste, lui.
 */
class Coffre {
  constructor() {
    this.d = new Map()
  }
  async getIdentityKeyPair() {
    return this.d.get("identite")
  }
  async getLocalRegistrationId() {
    return this.d.get("registrationId")
  }
  poseIdentite(couple, registrationId) {
    this.d.set("identite", couple)
    this.d.set("registrationId", registrationId)
  }
  async isTrustedIdentity() {
    return true
  }
  async saveIdentity(id, cle) {
    const avant = this.d.get(`identite.${id}`)
    this.d.set(`identite.${id}`, b64(cle))
    return avant !== undefined && avant !== b64(cle)
  }
  async loadIdentityKey(id) {
    const v = this.d.get(`identite.${id}`)
    return v ? deB64(v) : undefined
  }
  async loadPreKey(id) {
    return this.d.get(`prekey.${id}`)
  }
  async storePreKey(id, couple) {
    this.d.set(`prekey.${id}`, couple)
  }
  async removePreKey(id) {
    this.d.delete(`prekey.${id}`)
  }
  async loadSignedPreKey(id) {
    return this.d.get(`prekeySignee.${id}`)
  }
  async storeSignedPreKey(id, couple) {
    this.d.set(`prekeySignee.${id}`, couple)
  }
  async removeSignedPreKey(id) {
    this.d.delete(`prekeySignee.${id}`)
  }
  async loadSession(id) {
    return this.d.get(`session.${id}`)
  }
  async storeSession(id, s) {
    this.d.set(`session.${id}`, s)
  }
  async removeSession(id) {
    this.d.delete(`session.${id}`)
  }
  async removeAllSessions() {}
}

/* ══════════════════ UN CLIENT ══════════════════ */

class Client {
  constructor(nom, userId, jeton) {
    this.nom = nom
    this.userId = userId
    this.jeton = jeton
    this.coffre = new Coffre()
    // Tiré large, comme dans le navigateur : fixer à 1 ferait que deux clients
    // du même compte se voleraient leurs enveloppes.
    this.deviceId = Math.floor(Math.random() * 2_000_000_000) + 1
  }

  async publierCles() {
    const identite = await KeyHelper.generateIdentityKeyPair()
    const registrationId = KeyHelper.generateRegistrationId()
    this.coffre.poseIdentite(identite, registrationId)

    const idSignee = Math.floor(Math.random() * 100_000) + 1
    const signee = await KeyHelper.generateSignedPreKey(identite, idSignee)
    await this.coffre.storeSignedPreKey(idSignee, signee.keyPair)

    const prekeys = []
    const base = Math.floor(Math.random() * 100_000) + 1
    for (let i = 0; i < 5; i++) {
      const id = base + i
      const pk = await KeyHelper.generatePreKey(id)
      await this.coffre.storePreKey(id, pk.keyPair)
      prekeys.push({ id, clePublique: b64(pk.keyPair.pubKey) })
    }

    return appel("/api/e2ee/cles", {
      methode: "PUT",
      jeton: this.jeton,
      corps: {
        deviceId: this.deviceId,
        registrationId,
        cleIdentite: b64(identite.pubKey),
        prekeySignee: {
          id: idSignee,
          clePublique: b64(signee.keyPair.pubKey),
          signature: b64(signee.signature),
        },
        prekeys,
      },
    })
  }

  async ouvrirVers(autreUserId) {
    const r = await appel(`/api/e2ee/cles/${autreUserId}`, { jeton: this.jeton })
    const devices = []
    for (const p of r.paquets) {
      const adresse = new SignalProtocolAddress(autreUserId, p.deviceId)
      await new SessionBuilder(this.coffre, adresse).processPreKey({
        identityKey: deB64(p.cleIdentite),
        registrationId: p.registrationId,
        signedPreKey: {
          keyId: p.prekeySignee.prekeyId,
          publicKey: deB64(p.prekeySignee.clePublique),
          signature: deB64(p.prekeySignee.signature),
        },
        preKey: p.prekeyUnique
          ? {
              keyId: p.prekeyUnique.prekeyId,
              publicKey: deB64(p.prekeyUnique.clePublique),
            }
          : undefined,
      })
      devices.push(p.deviceId)
    }
    return { devices, paquets: r.paquets }
  }

  async envoyer(convId, destId, devices, texte) {
    const octets = new TextEncoder().encode(texte)
    const enveloppes = []
    for (const deviceId of devices) {
      const adresse = new SignalProtocolAddress(destId, deviceId)
      const chiffre = await new SessionCipher(this.coffre, adresse).encrypt(octets.buffer)
      enveloppes.push({
        destinataireId: destId,
        destinataireDevice: deviceId,
        type: chiffre.type,
        corps: Buffer.from(chiffre.body, "binary").toString("base64"),
      })
    }
    await appel("/api/e2ee/enveloppes", {
      methode: "POST",
      jeton: this.jeton,
      corps: { convId, deviceId: this.deviceId, enveloppes },
    })
    return enveloppes
  }

  async relever() {
    const r = await appel(`/api/e2ee/enveloppes?deviceId=${this.deviceId}`, {
      jeton: this.jeton,
    })
    return r.enveloppes ?? []
  }

  async lire(e) {
    const adresse = new SignalProtocolAddress(e.expediteurId, e.expediteurDevice)
    const chiffreur = new SessionCipher(this.coffre, adresse)
    const binaire = Buffer.from(e.corps, "base64").toString("binary")
    const clair =
      e.type === 3
        ? await chiffreur.decryptPreKeyWhisperMessage(binaire, "binary")
        : await chiffreur.decryptWhisperMessage(binaire, "binary")
    return new TextDecoder().decode(new Uint8Array(clair))
  }

  async acquitter(ids) {
    if (ids.length === 0) return
    await appel(`/api/e2ee/enveloppes?ids=${ids.join(",")}`, {
      methode: "DELETE",
      jeton: this.jeton,
    })
  }
}

/* ══════════════════ PRÉPARATION DES COMPTES ══════════════════ */

async function compteDeTest(marque) {
  /*
   * ⚠️ BCRYPT DIRECTEMENT, ET NON UN IMPORT DE `src/lib/password.ts`.
   *
   * 🐛 PREMIÈRE ERREUR DU BANC. On écrivait :
   *     const { hashPassword } = await import("../src/lib/password.js")
   *       .catch(() => ({}))
   * Node ne sait pas lire du TypeScript : l'import échouait, le `.catch`
   * l'avalait, `hashPassword` valait `undefined`, et le compte partait en base
   * SANS mot de passe. La connexion répondait « Identifiants incorrects » —
   * message qui envoie chercher le défaut du mauvais côté, dans la route
   * d'authentification, alors qu'il était dans la préparation du test.
   *
   * Leçon : un `.catch` qui rend un objet vide transforme une panne bruyante en
   * panne muette, et déplace le symptôme loin de sa cause.
   *
   * Les mêmes 12 tours que `SALT_ROUNDS` côté serveur : un autre coût serait
   * accepté par `bcrypt.compare`, mais ne refléterait plus ce que le serveur
   * fabrique réellement.
   */
  const bcrypt = require("bcryptjs")
  const email = `banc-${marque}@e2ee.test`
  const motDePasse = "MotDePasseDeTest!2026"
  const empreinte = await bcrypt.hash(motDePasse, 12)

  /*
   * 🐛 DEUXIÈME ERREUR DU BANC : on ne créait le compte QUE s'il n'existait
   * pas. Or le premier essai en avait déjà déposé un, sans mot de passe (voir
   * ci-dessus). Les essais suivants retrouvaient ce compte infirme et
   * échouaient à se connecter, en boucle, pour une cause déjà corrigée.
   *
   * ⚠️ UN BANC D'ESSAI DOIT ÊTRE IDEMPOTENT : il ramène le monde dans l'état
   * qu'il attend, au lieu de supposer l'avoir trouvé. D'où l'`upsert`, qui
   * repose le mot de passe à chaque exécution.
   *
   * ⚠️ LE COMPTE EST POSÉ EN BASE, PAS PAR LE PARCOURS D'INSCRIPTION : celui-ci
   * passe par un code OTP envoyé par courriel, qu'un script ne peut pas relever.
   * La CONNEXION, elle, emprunte la vraie route — c'est elle qui délivre le
   * jeton dont dépendent toutes les routes testées ensuite.
   */
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: empreinte, emailVerified: true },
    create: {
      email,
      nom: `Banc ${marque}`,
      passwordHash: empreinte,
      publicNumber: `E2EE${marque}${Math.floor(Math.random() * 100000)}`,
      emailVerified: true,
    },
  })
  return { user, email, motDePasse }
}
/* ══════════════════ LE SCÉNARIO ══════════════════ */

async function main() {
  console.log("\n════ BANC D'ESSAI — CHIFFREMENT DE BOUT EN BOUT ════\n")

  console.log("① Comptes de test")
  const a = await compteDeTest("alice")
  const b = await compteDeTest("bob")
  verifier(!!a.user.id && !!b.user.id, "deux comptes existent")
  verifier(a.user.id !== b.user.id, "ce sont bien deux comptes distincts")


  /*
   * 🐛 TROISIÈME ERREUR DU BANC, ET LA PLUS INSTRUCTIVE : L'ÉTAT S'ACCUMULE.
   *
   * Chaque exécution tirait un nouvel identifiant d'appareil et publiait un jeu
   * de clés de plus. Bob se retrouvait donc avec PLUSIEURS identités en base —
   * une par essai — toutes servies par `GET /api/e2ee/cles/<bob>`.
   *
   * Alice, obéissante, chiffrait pour chacune. Bob relevait, et ne savait lire
   * que celle de l'exécution en cours : les autres appartenaient à des
   * appareils dont il n'avait plus le coffre. D'où « No record for device ».
   *
   * ⚠️ CE N'EST PAS UN DÉFAUT DU PROTOCOLE, C'EST SON FONCTIONNEMENT NORMAL —
   * et c'est exactement ce qui arrivera en vrai le jour où quelqu'un
   * désinstallera puis réinstallera : ses anciennes identités restent publiées,
   * et ses correspondants continuent de chiffrer pour un appareil qui ne lira
   * plus rien.
   *
   * 🔴 DETTE DE PRODUCTION IDENTIFIÉE PAR CE TEST : il faut un moyen de RETIRER
   * une identité d'appareil — à la déconnexion, et par ménage des identités
   * qui ne relèvent plus depuis longtemps. Sans cela, chaque message est
   * chiffré pour une pile d'appareils morts, et le stock de pré-clés se vide
   * pour rien.
   *
   * Ici, on repart d'un monde propre : un banc doit ramener l'état qu'il
   * attend, jamais supposer l'avoir trouvé.
   */
  console.log("\n①bis Remise à zéro de l'état chiffré des deux comptes")
  const comptes = [a.user.id, b.user.id]
  const envSupprimees = await prisma.e2eeEnveloppe.deleteMany({
    where: { OR: [{ expediteurId: { in: comptes } }, { destinataireId: { in: comptes } }] },
  })
  // Les pré-clés tombent par cascade avec leur identité.
  const idSupprimees = await prisma.e2eeIdentite.deleteMany({
    where: { userId: { in: comptes } },
  })
  verifier(true, `${idSupprimees.count} identité(s) et ${envSupprimees.count} enveloppe(s) d'essais précédents retirées`)
  console.log("\n② Connexion par la vraie route")
  const sessionA = await appel("/api/auth/login", {
    methode: "POST",
    corps: {
      identifier: a.email,
      password: a.motDePasse,
      deviceId: `banc-alice-${Date.now()}`,
      typeDevice: 0,
    },
  })
  const sessionB = await appel("/api/auth/login", {
    methode: "POST",
    corps: {
      identifier: b.email,
      password: b.motDePasse,
      deviceId: `banc-bob-${Date.now()}`,
      typeDevice: 0,
    },
  })
  verifier(!!sessionA.accessToken, "Alice obtient un jeton")
  verifier(!!sessionB.accessToken, "Bob obtient un jeton")

  const alice = new Client("Alice", a.user.id, sessionA.accessToken)
  const bob = new Client("Bob", b.user.id, sessionB.accessToken)

  console.log("\n③ Publication des clés publiques")
  const pubA = await alice.publierCles()
  const pubB = await bob.publierCles()
  verifier(pubA.prekeysRestantes === 5, `Alice a ${pubA.prekeysRestantes} pré-clés`)
  verifier(pubB.prekeysRestantes === 5, `Bob a ${pubB.prekeysRestantes} pré-clés`)

  console.log("\n④ Le serveur ne détient aucune clé privée")
  const lignes = await prisma.e2eeIdentite.findMany({
    where: { userId: { in: [a.user.id, b.user.id] } },
  })
  const champs = JSON.stringify(lignes)
  verifier(!/privKey|privateKey|cle_privee/i.test(champs), "aucun champ de clé privée en base")
  verifier(
    lignes.every((l) => l.cleIdentite && l.cleIdentite.length < 200),
    "les clés d'identité rangées ont bien la taille d'une clé publique",
  )

  console.log("\n⑤ Alice ouvre une session vers Bob (X3DH)")
  const { devices, paquets } = await alice.ouvrirVers(b.user.id)
  verifier(devices.length === 1, `un paquet reçu, pour l'appareil ${devices[0]}`)
  verifier(!!paquets[0].prekeyUnique, "une pré-clé à usage unique a été servie")

  console.log("\n⑥ La pré-clé unique est bien CONSOMMÉE")
  const resteB = await prisma.e2eePrekeyUnique.count({
    where: { identite: { userId: b.user.id }, consommeLe: null },
  })
  verifier(resteB === 4, `il reste ${resteB} pré-clés libres chez Bob (4 attendu)`)

  console.log("\n⑦ Alice chiffre et dépose")
  const conv = await prisma.conversation.create({
    data: {
      isGroup: false,
      participants: {
        create: [{ userId: a.user.id }, { userId: b.user.id }],
      },
    },
  })
  const SECRET = "Rendez-vous à 14h, porte B. — message de contrôle"
  const enveloppes = await alice.envoyer(conv.id, b.user.id, devices, SECRET)
  verifier(enveloppes.length === 1, "une enveloppe par appareil destinataire")
  /*
   * 🐛 QUATRIÈME ERREUR, ET LA PLUS COÛTEUSE À TROUVER : on attendait le type
   * 1 pour le premier message. La bibliothèque renvoie 3.
   *
   * Les noms trompent — `PreKeyWhisperMessage` semble « premier », donc 1 —
   * mais les valeurs viennent de `libsignal-protocol-javascript` :
   * `WHISPER = 1`, `PREKEY_BUNDLE = 3`.
   *
   * ⚠️ LE SYMPTÔME DÉSIGNAIT LE MAUVAIS COUPABLE : en déchiffrant avec la
   * mauvaise méthode, on obtient « No record for device », qui parle
   * d'appareil et envoie fouiller du côté des identités publiées.
   */
  verifier(enveloppes[0].type === 3, "type 3 : elle ouvre la session (PreKeyWhisperMessage)")

  console.log("\n⑧ CE QUI TRANSITE EST-IL VRAIMENT ILLISIBLE ?")
  const enBase = await prisma.e2eeEnveloppe.findFirst({
    where: { convId: conv.id },
    select: { corps: true },
  })
  const clairDansLeChiffre = Buffer.from(enBase.corps, "base64")
    .toString("utf8")
    .includes("Rendez-vous")
  verifier(!clairDansLeChiffre, "le texte clair n'apparaît PAS dans le corps stocké")
  verifier(
    !enBase.corps.includes("Rendez-vous"),
    "ni en base64 brut",
  )

  console.log("\n⑨ Bob relève et déchiffre")
  const recues = await bob.relever()
  verifier(recues.length === 1, "une enveloppe en attente")
  const clair = await bob.lire(recues[0])
  verifier(clair === SECRET, `le texte revient identique : « ${clair} »`)

  console.log("\n⑩ L'accusé de réception retire l'enveloppe")
  await bob.acquitter([recues[0].id])
  const apres = await bob.relever()
  verifier(apres.length === 0, "plus rien en attente")

  console.log("\n⑪ La conversation continue (Double Ratchet)")
  await bob.ouvrirVers(a.user.id).catch(() => {})
  const REPONSE = "Bien reçu. Je serai là. — second message"
  await bob.envoyer(conv.id, a.user.id, [alice.deviceId], REPONSE)
  const pourAlice = await alice.relever()
  verifier(pourAlice.length === 1, "Alice a une réponse en attente")
  const clair2 = await alice.lire(pourAlice[0])
  verifier(clair2 === REPONSE, `la réponse revient identique : « ${clair2} »`)

  console.log("\n⑫ Un tiers ne peut pas déposer chez quelqu'un hors conversation")
  let refuse = false
  try {
    await alice.envoyer(conv.id, "00000000-0000-0000-0000-000000000000", [1], "intrusion")
  } catch {
    refuse = true
  }
  verifier(refuse, "le serveur refuse un destinataire hors de la conversation")


  console.log("\n⑬ Activer le chiffrement sur la conversation")
  const avant = await appel(`/api/conversations/${conv.id}/e2ee`, { jeton: sessionA.accessToken })
  verifier(avant.e2eeActif === false, "elle est en clair au départ")
  verifier(avant.activable === true, "elle est activable : les deux ont des clés")
  const apresAct = await appel(`/api/conversations/${conv.id}/e2ee`, {
    methode: "POST",
    jeton: sessionA.accessToken,
  })
  verifier(apresAct.e2eeActif === true, "le chiffrement est actif")

  /*
   * ⚠️ ON REDEMANDE, ET CE N'EST PAS DU ZÈLE : deux appareils du même compte
   * peuvent activer en même temps. Une seconde demande doit passer sans se
   * plaindre, sinon le second appareil verrait une erreur pour une action qui
   * a réussi.
   */
  const rejoue = await appel(`/api/conversations/${conv.id}/e2ee`, {
    methode: "POST",
    jeton: sessionB.accessToken,
  })
  verifier(rejoue.deja === true, "une seconde activation est idempotente")

  console.log("\n⑭ Le message du fil ne porte PAS le texte")
  /*
   * 🔴 LE CŒUR DU BRANCHEMENT AU FIL.
   *
   * La ligne de `message` existe — le fil a besoin de l'ordre, de l'heure, de
   * l'expéditeur — mais son `content` est NUL. Le texte vit dans l'enveloppe,
   * et nulle part ailleurs.
   */
  const SECRET3 = "Le contenu ne doit pas etre dans la table message"
  const ligne = await prisma.message.create({
    data: { convId: conv.id, senderId: a.user.id, content: null, type: "TEXT" },
    select: { id: true, content: true },
  })
  const env3 = await alice.envoyer(conv.id, b.user.id, devices, SECRET3)
  await prisma.e2eeEnveloppe.updateMany({
    where: { convId: conv.id, messageId: null, destinataireId: b.user.id },
    data: { messageId: ligne.id },
  })
  verifier(ligne.content === null, "la ligne de message n'a pas de contenu")
  verifier(env3.length === 1, "le contenu est parti dans une enveloppe")

  const relue = await prisma.message.findUnique({
    where: { id: ligne.id },
    select: { content: true, e2eeEnveloppes: { select: { id: true, corps: true } } },
  })
  verifier(relue.content === null, "relue en base : toujours aucun contenu en clair")
  verifier(relue.e2eeEnveloppes.length >= 1, "l'enveloppe est bien rattachée au message")
  verifier(
    !Buffer.from(relue.e2eeEnveloppes[0].corps, "base64").toString("utf8").includes("contenu"),
    "et son corps reste illisible",
  )

  console.log("\n⑮ Supprimer le message emporte ses enveloppes")
  await prisma.message.delete({ where: { id: ligne.id } })
  const orphelines = await prisma.e2eeEnveloppe.count({ where: { messageId: ligne.id } })
  verifier(orphelines === 0, "aucune enveloppe orpheline (cascade)")

  console.log("\n⑯ Un groupe est refusé, explicitement")
  const groupe = await prisma.conversation.create({
    data: {
      isGroup: true,
      name: "Banc groupe",
      participants: { create: [{ userId: a.user.id }, { userId: b.user.id }] },
    },
  })
  let refuseGroupe = ""
  try {
    await appel(`/api/conversations/${groupe.id}/e2ee`, {
      methode: "POST",
      jeton: sessionA.accessToken,
    })
  } catch (e) {
    refuseGroupe = e.message
  }
  verifier(
    refuseGroupe.includes("GROUPE_NON_SUPPORTE"),
    "le serveur refuse un groupe en le DISANT (Sender Keys non implémenté)",
  )
  await prisma.conversation.delete({ where: { id: groupe.id } })

  console.log("\n⑰ Une conversation chiffrée REFUSE le texte en clair")
  /*
   * 🔴 LE CONTRÔLE LE PLUS IMPORTANT DE CE LOT.
   *
   * Sans cette garde, l'écran annonce « chiffrée » pendant que le serveur
   * range le contenu lisible à côté. Il MENT à l'utilisateur au lieu
   * d'échouer — et un mensonge sur du chiffrement vaut moins que pas de
   * chiffrement du tout, puisqu'il fait prendre des risques qu'on croyait
   * écartés.
   */
  let refuseClair = ""
  try {
    await appel("/api/conversations/" + conv.id + "/messages", {
      methode: "POST",
      jeton: sessionA.accessToken,
      corps: { content: "du clair dans un fil chiffré", type: "TEXT" },
    })
  } catch (e) {
    refuseClair = e.message
  }
  verifier(refuseClair !== "", "la route ordinaire refuse d'écrire en clair")

  const fuite = await prisma.message.findFirst({
    where: { convId: conv.id, content: { not: null } },
    select: { content: true },
  })
  verifier(fuite === null, "aucun message en clair n'a atterri dans le fil chiffré")
  console.log("\n⑱ Un AGENT est hors périmètre, comme un standard")
  /*
   * 🐛 CE CONTRÔLE EXISTE PARCE QUE LA RÈGLE ÉTAIT FAUSSE.
   *
   * La première version n'excluait que les standards (types 3 et 4) et
   * laissait passer les AGENTS (type 2). Le raisonnement était plausible :
   * « un agent est une personne, donc il peut chiffrer ». Il est faux — ce
   * n'est pas la nature du titulaire qui compte, c'est QUI A BESOIN DE LIRE.
   * Les échanges d'un agent avec ses clients sont relus par sa hiérarchie et
   * passés à un collègue lors d'un transfert.
   *
   * ⚠️ LE DÉFAUT NE SE SERAIT VU QU'EN PRODUCTION, le jour où un superviseur
   * aurait ouvert un fil devenu illisible — et il aurait été IRRÉVERSIBLE,
   * puisque le serveur n'a pas de quoi rouvrir ce qui est chiffré.
   */
  const agent = await prisma.user.upsert({
    where: { email: "banc-agent@e2ee.test" },
    update: { typeCompte: 2 },
    create: {
      email: "banc-agent@e2ee.test",
      nom: "Banc agent",
      typeCompte: 2,
      publicNumber: "E2EEAGENT" + Math.floor(Math.random() * 100000),
      emailVerified: true,
    },
  })
  const convAgent = await prisma.conversation.create({
    data: {
      isGroup: false,
      participants: { create: [{ userId: a.user.id }, { userId: agent.id }] },
    },
  })

  const vu = await appel("/api/conversations/" + convAgent.id + "/e2ee", {
    jeton: sessionA.accessToken,
  })
  verifier(vu.activable === false, "le GET annonce que ce n'est pas activable")
  verifier(vu.motif === "HORS_PERIMETRE", "et il en DONNE la raison : " + vu.motif)

  let refusAgent = ""
  try {
    await appel("/api/conversations/" + convAgent.id + "/e2ee", {
      methode: "POST",
      jeton: sessionA.accessToken,
    })
  } catch (e) {
    refusAgent = e.message
  }
  verifier(
    refusAgent.includes("HORS_PERIMETRE"),
    "le POST refuse aussi — GET et POST disent la même chose",
  )
  await prisma.conversation.delete({ where: { id: convAgent.id } })
  console.log("\n⑲ Le fil chiffré, de bout en bout, par les vraies routes")
  /*
   * 🔴 LE SCÉNARIO COMPLET, celui que le navigateur jouera : on crée la LIGNE
   * du fil sans contenu, puis on y rattache les enveloppes.
   *
   * ⚠️ DANS CET ORDRE, ET PAS L'INVERSE. Il faut l'identifiant de la ligne
   * pour rattacher les enveloppes. Déposer d'abord laisserait des enveloppes
   * orphelines qu'aucun fil ne réclamerait jamais — invisibles, donc jamais
   * corrigées. Un message vide, lui, se voit et se renvoie.
   */
  const ligne2 = await appel("/api/conversations/" + conv.id + "/messages", {
    methode: "POST",
    jeton: sessionA.accessToken,
    corps: { type: "TEXT", chiffre: true },
  })
  verifier(!!ligne2.id, "la ligne du fil est créée, sans contenu")

  const env4 = await alice.envoyer(conv.id, b.user.id, devices, "Message du fil chiffré")
  await appel("/api/e2ee/enveloppes", {
    methode: "POST",
    jeton: sessionA.accessToken,
    corps: {
      convId: conv.id,
      deviceId: alice.deviceId,
      messageId: ligne2.id,
      enveloppes: env4,
    },
  })

  const recues2 = await bob.relever()
  const pourLigne = recues2.find((e) => e.messageId === ligne2.id)
  verifier(!!pourLigne, "Bob reçoit une enveloppe RATTACHÉE à la ligne du fil")
  if (pourLigne) {
    const clair3 = await bob.lire(pourLigne)
    verifier(clair3 === "Message du fil chiffré", "et son contenu revient : « " + clair3 + " »")
  }

  console.log("\n⑳ Une enveloppe ne peut pas être rattachée au message d'un AUTRE fil")
  /*
   * ⚠️ FUITE QUE LE CHIFFREMENT NE PEUT PAS EMPÊCHER, parce qu'elle a lieu
   * APRÈS le déchiffrement, chez quelqu'un qui a bien le droit de lire. Sans
   * ce contrôle, on rattacherait le contenu d'un fil au message d'un autre, et
   * le destinataire verrait un texte écrit pour une autre conversation.
   */
  const autreConv = await prisma.conversation.create({
    data: {
      isGroup: false,
      participants: { create: [{ userId: a.user.id }, { userId: b.user.id }] },
    },
  })
  const ligneAilleurs = await prisma.message.create({
    data: { convId: autreConv.id, senderId: a.user.id, type: "TEXT" },
    select: { id: true },
  })
  let refuseAilleurs = ""
  try {
    await appel("/api/e2ee/enveloppes", {
      methode: "POST",
      jeton: sessionA.accessToken,
      corps: {
        convId: conv.id,
        deviceId: alice.deviceId,
        messageId: ligneAilleurs.id,
        enveloppes: env4,
      },
    })
  } catch (e) {
    refuseAilleurs = e.message
  }
  verifier(refuseAilleurs !== "", "le serveur refuse un message d'une autre conversation")
  await prisma.conversation.delete({ where: { id: autreConv.id } })
  console.log(
    `\n════ ${echecs === 0 ? "TOUT EST VERT" : `${echecs} ÉCHEC(S)`} ════\n`,
  )
  await prisma.$disconnect()
  process.exit(echecs === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error("\n💥 Le banc s'est arrêté :", e.message)
  await prisma.$disconnect()
  process.exit(1)
})
