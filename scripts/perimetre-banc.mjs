/**
 * BANC — le périmètre du chiffrement et l'activation d'un groupe (lot 2b,
 * cours chapitre 33).
 *
 * Joue les VRAIES routes contre un serveur local (`next dev -p 3107`), sur la
 * base de DÉVELOPPEMENT.
 *
 *   ① les types 2, 3 et 4 chiffrent désormais, le 9 et l'inconnu non ;
 *   ② un tête-à-tête avec un compte qui envoie par l'API est refusé
 *     (EMETTEUR_API, provisoire) — un groupe ne l'est pas ;
 *   ③ un groupe ne s'active que par un administrateur, depuis un appareil qui a
 *     publié ses clés, et crée la version 1 en même temps que le drapeau ;
 *   ④ deux activations simultanées : une seule version 1, aucune erreur ;
 *   ⑤ l'archive et le coffre suivent la même liste blanche.
 *
 * Lancer : API=http://localhost:3107 node scripts/perimetre-banc.mjs
 */
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"
import { randomBytes } from "node:crypto"

const API = process.env.API ?? "http://localhost:3107"
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

/** Un compte de banc, connecté, AVEC une identité publiée sur l'appareil 1. */
async function compte(marque) {
  const email = `perimetre-${marque}@banc.test`
  const motDePasse = "MotDePasseDeTest!2026"
  const hash = await bcrypt.hash(motDePasse, 12)
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, emailVerified: true, typeCompte: 0 },
    create: {
      email,
      nom: `Périmètre ${marque}`,
      passwordHash: hash,
      publicNumber: `7${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
      emailVerified: true,
      typeCompte: 0,
    },
  })
  await prisma.developerAccount.deleteMany({ where: { userId: user.id } })
  await prisma.e2eeIdentite.upsert({
    where: { userId_deviceId: { userId: user.id, deviceId: 1 } },
    update: {},
    create: {
      userId: user.id,
      deviceId: 1,
      registrationId: 1000 + Math.floor(Math.random() * 9000),
      cleIdentite: Buffer.concat([Buffer.from([5]), randomBytes(32)]).toString("base64"),
    },
  })
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    // Une adresse de banc par compte : la connexion est limitée à 5 par minute
    // et par adresse, et ce banc se relance souvent.
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.99.${Math.floor(Math.random() * 250)}.${marque.charCodeAt(0)}` },
    body: JSON.stringify({ identifier: email, password: motDePasse, deviceId: `banc-perimetre-${marque}`, typeDevice: 0 }),
  })
  if (!r.ok) throw new Error(`login ${marque} → ${r.status} ${await r.text()}`)
  return { user, jeton: (await r.json()).accessToken }
}

const appel = (qui, chemin, init = {}) =>
  fetch(`${API}${chemin}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}), Authorization: `Bearer ${qui.jeton}` },
  })
const typer = (qui, typeCompte) => prisma.user.update({ where: { id: qui.user.id }, data: { typeCompte } })
const etat = async (qui, conv) => (await (await appel(qui, `/api/conversations/${conv}/e2ee`)).json())
const activer = (qui, conv, corps) =>
  appel(qui, `/api/conversations/${conv}/e2ee`, { method: "POST", body: corps === undefined ? undefined : JSON.stringify(corps) })

async function conversation(isGroup, membres) {
  const c = await prisma.conversation.create({
    data: {
      isGroup,
      name: isGroup ? "Banc périmètre" : null,
      participants: { create: membres.map(([qui, role]) => ({ userId: qui.user.id, role })) },
    },
    select: { id: true },
  })
  crees.push(c.id)
  return c.id
}

const crees = []
const A = await compte("a")
const B = await compte("b")
const C = await compte("c")

try {
  titre("① les types de compte")
  for (const [type, attendu] of [[0, true], [2, true], [3, true], [4, true], [9, false], [1, false]]) {
    await typer(B, type)
    const t = await conversation(false, [[A, "MEMBER"], [B, "MEMBER"]])
    const e = await etat(A, t)
    verifie(`type ${type} : ${attendu ? "chiffre" : "refusé"}`,
      e.activable === attendu && (attendu || e.motif === "HORS_PERIMETRE"), JSON.stringify(e))
  }
  await typer(B, 9)
  let t = await conversation(false, [[A, "MEMBER"], [B, "MEMBER"]])
  let r = await activer(A, t)
  verifie("le POST refuse aussi l'administrateur de plateforme (400 HORS_PERIMETRE)",
    r.status === 400 && (await r.json()).error?.code === "HORS_PERIMETRE")
  await typer(B, 0)

  titre("② les comptes qui envoient par l'API")
  await prisma.developerAccount.create({ data: { userId: B.user.id } })
  t = await conversation(false, [[A, "MEMBER"], [B, "MEMBER"]])
  let e = await etat(A, t)
  verifie("tête-à-tête refusé : EMETTEUR_API", e.activable === false && e.motif === "EMETTEUR_API", JSON.stringify(e))
  r = await activer(A, t)
  verifie("le POST aussi (400)", r.status === 400 && (await r.json()).error?.code === "EMETTEUR_API")
  let g = await conversation(true, [[A, "ADMIN"], [B, "MEMBER"]])
  e = await etat(A, g)
  verifie("un groupe où il est membre reste activable", e.activable === true, JSON.stringify(e))
  await prisma.developerAccount.deleteMany({ where: { userId: B.user.id } })
  t = await conversation(false, [[A, "MEMBER"], [B, "MEMBER"]])
  r = await activer(A, t)
  verifie("sans compte développeur, le tête-à-tête s'active", r.ok, `${r.status} ${await r.clone().text()}`)

  titre("③ activer un groupe")
  await typer(C, 2)
  g = await conversation(true, [[A, "ADMIN"], [B, "MEMBER"], [C, "MEMBER"]])
  e = await etat(B, g)
  verifie("un membre voit le groupe activable, mais pas par lui", e.activable === true && e.jePeuxActiver === false,
    JSON.stringify(e))
  verifie("l'administrateur, lui, peut", (await etat(A, g)).jePeuxActiver === true)
  r = await activer(B, g, { appareil: 1 })
  verifie("un membre est refusé (403 ADMIN_REQUIS)", r.status === 403 && (await r.json()).error?.code === "ADMIN_REQUIS")
  r = await activer(A, g)
  verifie("sans « appareil » : 400", r.status === 400, String(r.status))
  r = await activer(A, g, { appareil: 7 })
  verifie("depuis un appareil sans clés : 409", r.status === 409, String(r.status))
  verifie("rien n'a bougé", (await prisma.conversation.findUnique({ where: { id: g } })).e2eeActif === false)
  r = await activer(A, g, { appareil: 1 })
  const corps = await r.json()
  verifie("l'administrateur active (un agent est membre)", r.ok && corps.cleVersion === 1 && corps.deja === false,
    JSON.stringify(corps))
  const conv = await prisma.conversation.findUnique({ where: { id: g } })
  verifie("drapeau ET version 1 sur la conversation", conv.e2eeActif === true && conv.cleVersion === 1)
  const versions = await prisma.e2eeCleVersion.findMany({ where: { convId: g } })
  verifie("une ligne de version : 1, ACTIVATION, par A sur l'appareil 1",
    versions.length === 1 && versions[0].version === 1 && versions[0].motif === "ACTIVATION" &&
      versions[0].creePar === A.user.id && versions[0].creeParAppareil === 1, JSON.stringify(versions))
  r = await activer(A, g, { appareil: 1 })
  verifie("réactiver : « déjà », sans erreur", r.ok && (await r.json()).deja === true)

  titre("④ deux administrateurs au même instant")
  g = await conversation(true, [[A, "ADMIN"], [B, "ADMIN"]])
  const [r1, r2] = await Promise.all([activer(A, g, { appareil: 1 }), activer(B, g, { appareil: 1 })])
  const [c1, c2] = [await r1.json(), await r2.json()]
  verifie("les deux répondent 200", r1.ok && r2.ok, `${r1.status} ${r2.status}`)
  verifie("un seul a créé la version", [c1, c2].filter((c) => c.deja === false).length === 1, JSON.stringify([c1, c2]))
  verifie("une seule ligne de version", (await prisma.e2eeCleVersion.count({ where: { convId: g } })) === 1)

  titre("⑤ archive et coffre")
  for (const [type, attendu] of [[2, true], [9, false]]) {
    await typer(C, type)
    for (const route of ["archive", "coffre"]) {
      r = await appel(C, `/api/e2ee/${route}`, { method: route === "coffre" ? "PUT" : "POST", body: "{}" })
      const code = r.status === 403 ? (await r.json()).error?.code : null
      verifie(`${route}, type ${type} : ${attendu ? "admis" : "refusé"}`,
        attendu ? code !== "HORS_PERIMETRE" : code === "HORS_PERIMETRE", `${r.status} ${code}`)
    }
  }
} finally {
  await prisma.conversation.deleteMany({ where: { id: { in: crees } } }).catch(() => undefined)
  await prisma.developerAccount.deleteMany({ where: { userId: B.user.id } }).catch(() => undefined)
  await prisma.$disconnect()
}

console.log(`\n${echecs === 0 ? "Tous les contrôles passent." : `${echecs} ÉCHEC(S).`}`)
process.exit(echecs === 0 ? 0 : 1)
