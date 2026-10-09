/**
 * BANC — le serveur d'un groupe chiffré (lot 2c, cours chapitre 33).
 *
 * Joue les VRAIES routes contre un serveur local (`next dev -p 3107`), sur la
 * base de DÉVELOPPEMENT. Le serveur ne déchiffre rien : les corps sont des
 * octets au bon FORMAT (0x01 | nonce | chiffré | signature), sans clé derrière.
 *
 *   ① envoyer : la charge de groupe est exigée, contrôlée, et rangée une fois ;
 *   ② relire : chaque membre reçoit le même chiffré ;
 *   ③ modifier : le nouveau chiffré remplace l'ancien ;
 *   ④ les versions : administrateur seulement, numéro attendu, une seule gagne ;
 *   ⑤ après un changement de clé, l'ancienne version est refusée ;
 *   ⑥ supprimer pour tous efface le chiffré ;
 *   ⑦ ajouter : refus sans clés ou hors périmètre ;
 *   ⑧ la copie du trousseau : déposer, relire, effacée au départ ;
 *   ⑨ les enveloppes de groupe : 1 000 par dépôt, pas de message, pas de blocage ;
 *   ⑩ les sonnettes (si WS est donné) : message, nouvelle version, départ.
 *
 * Lancer : API=http://localhost:3107 WS=ws://localhost:3108 node scripts/groupe-chiffre-banc.mjs
 *          (sans WS, ⑩ est sauté ; le serveur WebSocket local doit partager
 *          le tuyau du pont avec Next — ne pas poser WS_INTERNAL_SOCKET depuis
 *          Git Bash, qui abîme les antislashs.)
 */
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"
import { randomBytes, randomUUID } from "node:crypto"
import WebSocket from "ws"

const API = process.env.API ?? "http://localhost:3107"
const WS = process.env.WS ?? ""
const prisma = new PrismaClient()

let echecs = 0
function verifie(libelle, condition, detail) {
  console.log(`  ${condition ? "✓" : "✗"} ${libelle}`)
  if (!condition) {
    echecs++
    if (detail !== undefined) console.log(`      ${detail}`)
  }
}
const titre = (t) => console.log(`\n${t}`)

async function compte(marque, { cles = true } = {}) {
  const email = `groupe-chiffre-${marque}@banc.test`
  const motDePasse = "MotDePasseDeTest!2026"
  const hash = await bcrypt.hash(motDePasse, 12)
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, emailVerified: true, typeCompte: 0 },
    create: {
      email,
      nom: `Groupe chiffré ${marque}`,
      passwordHash: hash,
      publicNumber: `7${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
      emailVerified: true,
      typeCompte: 0,
    },
  })
  await prisma.e2eeIdentite.deleteMany({ where: { userId: user.id } })
  if (cles) {
    await prisma.e2eeIdentite.create({
      data: {
        userId: user.id,
        deviceId: 1,
        registrationId: 1000 + Math.floor(Math.random() * 9000),
        cleIdentite: Buffer.concat([Buffer.from([5]), randomBytes(32)]).toString("base64"),
      },
    })
  }
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    // Une adresse de banc par compte : la connexion est limitée par adresse.
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.98.${Math.floor(Math.random() * 250)}.${marque.charCodeAt(0)}` },
    body: JSON.stringify({ identifier: email, password: motDePasse, deviceId: `banc-groupe-${marque}`, typeDevice: 0 }),
  })
  if (!r.ok) throw new Error(`login ${marque} → ${r.status} ${await r.text()}`)
  return { user, jeton: (await r.json()).accessToken }
}

const appel = (qui, chemin, init = {}) =>
  fetch(`${API}${chemin}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}), Authorization: `Bearer ${qui.jeton}` },
  })
const json = (qui, chemin, methode, corps) =>
  appel(qui, chemin, { method: methode, body: corps === undefined ? undefined : JSON.stringify(corps) })
const code = async (r) => (await r.clone().json().catch(() => ({}))).error?.code

/** Un corps au FORMAT du groupe : 0x01 | nonce 12 | chiffré + étiquette | signature 64. */
const corpsGroupe = (taille = 40) =>
  Buffer.concat([Buffer.from([1]), randomBytes(12), randomBytes(taille + 16), randomBytes(64)]).toString("base64")

/** Une connexion WebSocket prête, qui garde tout ce qu'elle reçoit. */
function connecter(qui) {
  return new Promise((resoudre, rejeter) => {
    const ws = new WebSocket(`${WS}?token=${qui.jeton}`)
    const recus = []
    ws.on("message", (b) => {
      try {
        const m = JSON.parse(String(b))
        recus.push(m)
        if (m.type === "ready") resoudre({ ws, recus })
      } catch {}
    })
    ws.on("error", rejeter)
    setTimeout(() => rejeter(new Error("WebSocket : pas de « ready » en 10 s")), 10000)
  })
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const recu = (canal, type, convId) => canal.recus.find((m) => m.type === type && m.donnees?.convId === convId) ??
  canal.recus.find((m) => m.type === type && m.convId === convId)

const crees = []
async function groupe(membres, { chiffre = true } = {}) {
  const c = await prisma.conversation.create({
    data: {
      isGroup: true,
      name: "Banc groupe chiffré",
      e2eeActif: chiffre,
      cleVersion: chiffre ? 1 : 0,
      participants: { create: membres.map(([qui, role]) => ({ userId: qui.user.id, role })) },
    },
    select: { id: true },
  })
  if (chiffre) {
    await prisma.e2eeCleVersion.create({
      data: { convId: c.id, version: 1, creePar: membres[0][0].user.id, creeParAppareil: 1, motif: "ACTIVATION" },
    })
  }
  crees.push(c.id)
  return c.id
}

const A = await compte("a")
const B = await compte("b")
const C = await compte("c")
const D = await compte("d", { cles: false })

try {
  const G = await groupe([[A, "ADMIN"], [B, "MEMBER"]])
  const messages = `/api/conversations/${G}/messages`

  titre("① envoyer")
  let r = await json(A, messages, "POST", { type: "TEXT", chiffre: true })
  verifie("sans charge de groupe : 409 CHARGE_GROUPE_INVALIDE", r.status === 409 && (await code(r)) === "CHARGE_GROUPE_INVALIDE",
    `${r.status} ${await code(r)}`)
  r = await json(A, messages, "POST", { type: "TEXT", chiffre: true, id: randomUUID(), groupe: { version: 1, appareil: 1, corps: "pas du base64 !" } })
  verifie("corps mal formé : 400", r.status === 400 && (await code(r)) === "CHARGE_GROUPE_INVALIDE")
  r = await json(A, messages, "POST", {
    type: "TEXT", chiffre: true,
    groupe: { version: 1, appareil: 1, corps: Buffer.concat([Buffer.from([2]), randomBytes(120)]).toString("base64") },
  })
  verifie("mauvais octet de format : 400", r.status === 400)
  r = await json(A, messages, "POST", { type: "TEXT", chiffre: true, id: randomUUID(), groupe: { version: 2, appareil: 1, corps: corpsGroupe() } })
  let e = await r.json()
  verifie("version inexistante : 409 VERSION_PERIMEE, avec la courante",
    r.status === 409 && e.error?.code === "VERSION_PERIMEE" && e.error?.cleVersion === 1, JSON.stringify(e))
  r = await json(A, messages, "POST", { type: "TEXT", chiffre: true, id: randomUUID(), groupe: { version: 1, appareil: 9, corps: corpsGroupe() } })
  verifie("appareil sans identité : 409 APPAREIL_INCONNU", r.status === 409 && (await code(r)) === "APPAREIL_INCONNU")
  r = await json(A, messages, "POST", { type: "TEXT", content: "en clair", chiffre: true, id: randomUUID(), groupe: { version: 1, appareil: 1, corps: corpsGroupe() } })
  verifie("avec du texte en clair : 400 CONTENU_EN_CLAIR", r.status === 400 && (await code(r)) === "CONTENU_EN_CLAIR")
  r = await json(A, messages, "POST", { type: "TEXT", content: "bonjour" })
  verifie("un message ordinaire : refusé (409)", r.status === 409)
  const corps1 = corpsGroupe()
  r = await json(A, messages, "POST", { type: "TEXT", chiffre: true, id: randomUUID(), groupe: { version: 1, appareil: 1, corps: corps1 } })
  e = await r.json()
  verifie("message chiffré accepté (201, chiffre: true)", r.status === 201 && e.chiffre === true, `${r.status} ${JSON.stringify(e)}`)
  const M = e.id
  verifie("l'identifiant tiré par l'appareil est gardé", typeof M === "string" && M.length === 36)
  r = await json(A, messages, "POST", { type: "TEXT", chiffre: true, groupe: { version: 1, appareil: 1, corps: corpsGroupe() } })
  verifie("sans identifiant tiré : 400", r.status === 400 && (await code(r)) === "CHARGE_GROUPE_INVALIDE")
  r = await json(A, messages, "POST", { type: "TEXT", chiffre: true, id: M, groupe: { version: 1, appareil: 1, corps: corpsGroupe() } })
  verifie("identifiant déjà pris : 409 ID_DEJA_PRIS", r.status === 409 && (await code(r)) === "ID_DEJA_PRIS")
  const ligne = await prisma.e2eeMessageGroupe.findUnique({ where: { messageId: M } })
  verifie("UN chiffré rangé, version 1, appareil 1", ligne?.corps === corps1 && ligne.version === 1 && ligne.expediteurAppareil === 1)
  verifie("la ligne du message n'a aucun contenu", (await prisma.message.findUnique({ where: { id: M } }))?.content === null)

  const T = await prisma.conversation.create({
    data: { isGroup: false, e2eeActif: true, participants: { create: [{ userId: A.user.id }, { userId: B.user.id }] } },
    select: { id: true },
  })
  crees.push(T.id)
  r = await json(A, `/api/conversations/${T.id}/messages`, "POST", { type: "TEXT", chiffre: true, id: randomUUID(), groupe: { version: 1, appareil: 1, corps: corpsGroupe() } })
  verifie("charge de groupe dans un tête-à-tête : 409", r.status === 409 && (await code(r)) === "CHARGE_GROUPE_INVALIDE")
  const GC = await groupe([[A, "ADMIN"], [B, "MEMBER"]], { chiffre: false })
  r = await json(A, `/api/conversations/${GC}/messages`, "POST", { type: "TEXT", chiffre: true, id: randomUUID(), groupe: { version: 1, appareil: 1, corps: corpsGroupe() } })
  verifie("charge de groupe dans un groupe en clair : 409", r.status === 409)

  titre("② relire")
  r = await appel(B, messages)
  let lu = ((await r.json()).messages ?? []).find((m) => m.id === M)
  verifie("B reçoit le chiffré, la version et l'appareil",
    lu?.chiffre === true && lu.groupe?.corps === corps1 && lu.groupe.version === 1 && lu.groupe.expediteurAppareil === 1,
    JSON.stringify(lu))

  titre("③ modifier")
  const corps2 = corpsGroupe(60)
  r = await json(A, `${messages}/${M}`, "PATCH", { chiffre: true, id: randomUUID(), groupe: { version: 1, appareil: 1, corps: corps2 } })
  verifie("modification acceptée", r.ok, `${r.status} ${await r.clone().text()}`)
  verifie("le chiffré est REMPLACÉ", (await prisma.e2eeMessageGroupe.findUnique({ where: { messageId: M } }))?.corps === corps2)
  verifie("le message est daté « modifié »", (await prisma.message.findUnique({ where: { id: M } }))?.editedAt !== null)
  r = await json(A, `${messages}/${M}`, "PATCH", { chiffre: true })
  verifie("sans charge de groupe : 409", r.status === 409 && (await code(r)) === "CHARGE_GROUPE_INVALIDE")
  r = await json(B, `${messages}/${M}`, "PATCH", { chiffre: true, id: randomUUID(), groupe: { version: 1, appareil: 1, corps: corpsGroupe() } })
  verifie("B ne modifie pas le message de A (403)", r.status === 403)

  titre("④ les versions de clé")
  const versions = `/api/conversations/${G}/e2ee/versions`
  r = await json(B, versions, "POST", { attendue: 2, appareil: 1, motif: "MANUEL" })
  verifie("un membre : 403 ADMIN_REQUIS", r.status === 403 && (await code(r)) === "ADMIN_REQUIS")
  r = await json(A, versions, "POST", { attendue: 2, appareil: 1, motif: "AJOUT" })
  verifie("motif inconnu : 400", r.status === 400)
  r = await json(A, versions, "POST", { attendue: 2, appareil: 9, motif: "MANUEL" })
  verifie("appareil sans identité : 409", r.status === 409 && (await code(r)) === "APPAREIL_INCONNU")
  r = await json(A, versions, "POST", { attendue: 2, appareil: 1, motif: "MANUEL" })
  verifie("l'administrateur réserve la version 2", r.status === 201 && (await r.json()).cleVersion === 2)
  r = await json(A, versions, "POST", { attendue: 2, appareil: 1, motif: "MANUEL" })
  e = await r.json()
  verifie("redemander 2 : 409 VERSION_CONFLIT, courante = 2", r.status === 409 && e.error?.code === "VERSION_CONFLIT" && e.error?.cleVersion === 2)
  r = await json(A, `/api/conversations/${GC}/e2ee/versions`, "POST", { attendue: 2, appareil: 1, motif: "MANUEL" })
  verifie("groupe en clair : 409", r.status === 409 && (await code(r)) === "PAS_GROUPE_CHIFFRE")
  await prisma.participant.update({ where: { convId_userId: { convId: G, userId: B.user.id } }, data: { role: "ADMIN" } })
  const [r1, r2] = await Promise.all([
    json(A, versions, "POST", { attendue: 3, appareil: 1, motif: "EXCLUSION" }),
    json(B, versions, "POST", { attendue: 3, appareil: 1, motif: "MANUEL" }),
  ])
  verifie("deux administrateurs pour la 3 : un 201, un 409", [r1.status, r2.status].sort().join() === "201,409",
    `${r1.status} ${r2.status}`)
  const lignes = await prisma.e2eeCleVersion.findMany({ where: { convId: G }, orderBy: { version: "asc" } })
  verifie("versions 1, 2, 3 — une ligne chacune", lignes.map((l) => l.version).join() === "1,2,3", JSON.stringify(lignes))
  verifie("cle_version = 3", (await prisma.conversation.findUnique({ where: { id: G } }))?.cleVersion === 3)

  titre("⑤ l'ancienne clé est refusée")
  r = await json(A, messages, "POST", { type: "TEXT", chiffre: true, id: randomUUID(), groupe: { version: 1, appareil: 1, corps: corpsGroupe() } })
  e = await r.json()
  verifie("écrire en version 1 : 409 VERSION_PERIMEE (courante 3)", r.status === 409 && e.error?.cleVersion === 3, JSON.stringify(e))
  r = await json(A, `${messages}/${M}`, "PATCH", { chiffre: true, id: randomUUID(), groupe: { version: 1, appareil: 1, corps: corpsGroupe() } })
  verifie("modifier en version 1 : 409 VERSION_PERIMEE", r.status === 409 && (await code(r)) === "VERSION_PERIMEE")
  r = await json(A, `${messages}/${M}`, "PATCH", { chiffre: true, id: randomUUID(), groupe: { version: 3, appareil: 1, corps: corpsGroupe() } })
  verifie("modifier en version 3 : accepté, la ligne passe en 3",
    r.ok && (await prisma.e2eeMessageGroupe.findUnique({ where: { messageId: M } }))?.version === 3)

  titre("⑥ supprimer pour tous")
  r = await appel(A, `${messages}/${M}?scope=everyone`, { method: "DELETE" })
  verifie("suppression acceptée", r.ok, String(r.status))
  verifie("le chiffré est effacé", (await prisma.e2eeMessageGroupe.count({ where: { messageId: M } })) === 0)
  lu = ((await (await appel(B, messages)).json()).messages ?? []).find((m) => m.id === M)
  verifie("B ne reçoit plus de chiffré", lu !== undefined && lu.groupe === undefined, JSON.stringify(lu))

  titre("⑦ ajouter un membre")
  const ajouter = (qui) => json(A, `/api/conversations/${G}/members`, "POST", { publicNumbers: [qui.user.publicNumber] })
  r = await ajouter(D)
  e = await r.json()
  verifie("sans clés publiées : 409 CLES_MANQUANTES, numéro nommé",
    r.status === 409 && e.error?.code === "CLES_MANQUANTES" && e.error?.numeros?.[0] === D.user.publicNumber, JSON.stringify(e))
  await prisma.user.update({ where: { id: C.user.id }, data: { typeCompte: 9 } })
  r = await ajouter(C)
  verifie("administrateur de plateforme : 409 HORS_PERIMETRE", r.status === 409 && (await code(r)) === "HORS_PERIMETRE")
  await prisma.user.update({ where: { id: C.user.id }, data: { typeCompte: 2 } })
  r = await ajouter(C)
  verifie("un agent avec des clés : ajouté", r.ok, `${r.status} ${await r.clone().text()}`)
  r = await json(A, `/api/conversations/${GC}/members`, "POST", { publicNumbers: [D.user.publicNumber] })
  verifie("groupe en clair : sans clés, ajouté quand même", r.ok, String(r.status))

  titre("⑧ la copie du trousseau")
  const copie = `/api/e2ee/trousseaux/${G}`
  r = await json(B, copie, "PUT", { corps: "copie-chiffree-de-B" })
  verifie("B dépose sa copie", r.ok, `${r.status} ${await r.clone().text()}`)
  r = await appel(B, copie)
  verifie("B la relit", r.ok && (await r.json()).corps === "copie-chiffree-de-B")
  r = await appel(B, `/api/e2ee/trousseaux`)
  verifie("elle est dans sa liste", ((await r.json()).trousseaux ?? []).some((t) => t.convId === G))
  r = await json(D, copie, "PUT", { corps: "intrus" })
  verifie("un non-membre : 404", r.status === 404)
  r = await json(A, `/api/e2ee/trousseaux/${GC}`, "PUT", { corps: "x" })
  verifie("un groupe en clair : 404", r.status === 404)
  r = await json(B, copie, "PUT", { corps: "" })
  verifie("corps vide : 400", r.status === 400)
  r = await json(B, `/api/conversations/${G}/leave`, "POST")
  verifie("B quitte le groupe", r.ok, String(r.status))
  verifie("sa copie est effacée", (await prisma.e2eeTrousseau.count({ where: { convId: G, userId: B.user.id } })) === 0)
  r = await appel(B, copie)
  verifie("il ne peut plus la lire (404)", r.status === 404)

  titre("⑨ les enveloppes du groupe")
  const enveloppes = (n, extra = {}) =>
    json(A, `/api/e2ee/enveloppes`, "POST", {
      convId: G,
      deviceId: 1,
      enveloppes: Array.from({ length: n }, () => ({ destinataireId: C.user.id, destinataireDevice: 1, type: 1, corps: "AAAA" })),
      ...extra,
    })
  r = await enveloppes(600)
  verifie("600 enveloppes en un dépôt (trousseau)", r.status === 201, `${r.status} ${await r.clone().text()}`)
  r = await enveloppes(1001)
  verifie("1 001 : refusé", r.status === 400 && (await code(r)) === "TOO_MANY")
  const autreMessage = await prisma.message.create({ data: { convId: G, senderId: A.user.id, type: "TEXT", status: "SENT" } })
  r = await enveloppes(1, { messageId: autreMessage.id })
  verifie("rattachées à un message : 400", r.status === 400)
  await prisma.blocked.create({ data: { alanyaID: C.user.id, idCallerBlock: A.user.id } })
  r = await enveloppes(1)
  verifie("C a bloqué A : le trousseau passe quand même", r.status === 201, `${r.status} ${await code(r)}`)

  if (WS) {
    titre("⑩ les sonnettes")
    const S = await groupe([[A, "ADMIN"], [B, "MEMBER"]])
    const canalB = await connecter(B)
    r = await json(A, `/api/conversations/${S}/messages`, "POST", { type: "TEXT", chiffre: true, id: randomUUID(), groupe: { version: 1, appareil: 1, corps: corpsGroupe() } })
    const idS = (await r.json()).id
    await pause(800)
    const arrivee = recu(canalB, "e2ee_arrivee", S)
    verifie("message : B est sonné (e2ee_arrivee, groupe)", arrivee !== undefined, JSON.stringify(canalB.recus.map((m) => m.type)))
    verifie("la trame porte l'identifiant et le drapeau groupe, jamais le chiffré",
      JSON.stringify(arrivee ?? {}).includes(idS) && JSON.stringify(arrivee ?? {}).includes("groupe") &&
        !JSON.stringify(arrivee ?? {}).includes("corps"), JSON.stringify(arrivee))
    r = await json(A, `/api/conversations/${S}/e2ee/versions`, "POST", { attendue: 2, appareil: 1, motif: "MANUEL" })
    await pause(800)
    verifie("nouvelle version : B est prévenu (e2ee_cle_version)", recu(canalB, "e2ee_cle_version", S) !== undefined,
      JSON.stringify(canalB.recus.map((m) => m.type)))
    r = await appel(A, `/api/conversations/${S}/members?userId=${B.user.id}`, { method: "DELETE" })
    await pause(800)
    const parti = recu(canalB, "e2ee_membre_parti", S)
    verifie("exclusion : B est prévenu (e2ee_membre_parti, exclu)", parti !== undefined && JSON.stringify(parti).includes("true"),
      JSON.stringify(canalB.recus.map((m) => m.type)))
    canalB.ws.close()
  } else {
    titre("⑩ sauté : WS non fourni")
  }
} finally {
  await prisma.blocked.deleteMany({ where: { alanyaID: C.user.id, idCallerBlock: A.user.id } }).catch(() => undefined)
  await prisma.e2eeEnveloppe.deleteMany({ where: { convId: { in: crees } } }).catch(() => undefined)
  await prisma.conversation.deleteMany({ where: { id: { in: crees } } }).catch(() => undefined)
  await prisma.user.update({ where: { id: C.user.id }, data: { typeCompte: 0 } }).catch(() => undefined)
  await prisma.$disconnect()
}

console.log(`\n${echecs === 0 ? "Tous les contrôles passent." : `${echecs} ÉCHEC(S).`}`)
process.exit(echecs === 0 ? 0 : 1)
