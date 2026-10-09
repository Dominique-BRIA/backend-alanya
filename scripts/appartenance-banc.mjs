/**
 * BANC — `isMembre` : partir, revenir, être exclu (lot 2, cours chapitre 33).
 *
 * Joue les VRAIES routes contre un serveur local (`next dev -p 3107`), sur la
 * base de DÉVELOPPEMENT. Trois comptes de banc (A admin, B, C) dans un groupe.
 *
 *   ① B part : sa ligne reste, marquée ; il ne lit plus rien, ne voit plus le
 *     groupe, ne peut ni l'archiver ni le SUPPRIMER pour les autres ; sa copie
 *     de trousseau est effacée ;
 *   ② A le réintègre : sa ligne est RÉACTIVÉE, pas dupliquée ;
 *   ③ A exclut C : `exclu_par` = A ; C ne reçoit plus de non-lus ;
 *   ④ un administrateur parti n'a plus de droits d'administrateur.
 *
 * Lancer : API=http://localhost:3107 node scripts/appartenance-banc.mjs
 */
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

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

async function compte(marque) {
  const email = `appartenance-${marque}@banc.test`
  const motDePasse = "MotDePasseDeTest!2026"
  const hash = await bcrypt.hash(motDePasse, 12)
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, emailVerified: true, typeCompte: 0 },
    create: {
      email,
      nom: `Appartenance ${marque}`,
      passwordHash: hash,
      publicNumber: `7${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
      emailVerified: true,
      typeCompte: 0,
    },
  })
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password: motDePasse, deviceId: `banc-appartenance-${marque}`, typeDevice: 0 }),
  })
  if (!r.ok) throw new Error(`login ${marque} → ${r.status} ${await r.text()}`)
  return { user, jeton: (await r.json()).accessToken }
}

const appel = (qui, chemin, init = {}) =>
  fetch(`${API}${chemin}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}), Authorization: `Bearer ${qui.jeton}` },
  })

const ligne = (convId, userId) =>
  prisma.participant.findUnique({ where: { convId_userId: { convId, userId } } })

const A = await compte("a")
const B = await compte("b")
const C = await compte("c")

const groupe = await prisma.conversation.create({
  data: {
    isGroup: true,
    name: "Banc appartenance",
    participants: {
      create: [
        { userId: A.user.id, role: "ADMIN" },
        { userId: B.user.id, role: "MEMBER" },
        { userId: C.user.id, role: "MEMBER" },
      ],
    },
  },
  select: { id: true },
})
const G = groupe.id

try {
  titre("① B part")
  await prisma.e2eeTrousseau.create({ data: { userId: B.user.id, convId: G, corps: "copie-de-B" } })
  let r = await appel(B, `/api/conversations/${G}/leave`, { method: "POST" })
  verifie("départ accepté", r.ok, `${r.status} ${await r.clone().text()}`)
  let l = await ligne(G, B.user.id)
  verifie("sa ligne RESTE, marquée", l !== null && l.estMembre === false && l.quitteLe !== null && l.excluPar === null,
    JSON.stringify(l))
  verifie("sa copie du trousseau est effacée",
    (await prisma.e2eeTrousseau.count({ where: { convId: G, userId: B.user.id } })) === 0)
  r = await appel(B, `/api/conversations/${G}/messages`)
  verifie("il ne lit plus les messages (403)", r.status === 403, String(r.status))
  r = await appel(B, `/api/conversations`)
  const liste = (await r.json()).conversations ?? []
  verifie("le groupe n'est plus dans SA liste", !liste.some((c) => c.id === G))
  r = await appel(A, `/api/conversations/${G}/members`)
  const membres = (await r.json()).members ?? []
  verifie("A ne le voit plus parmi les membres", membres.length === 2 && !membres.some((m) => m.id === B.user.id),
    JSON.stringify(membres.map((m) => m.id)))
  r = await appel(B, `/api/conversations/${G}/archive`, { method: "PATCH", body: JSON.stringify({ archived: true }) })
  verifie("il ne peut plus l'archiver (404)", r.status === 404, String(r.status))
  r = await appel(B, `/api/conversations/${G}/delete`, { method: "DELETE" })
  verifie("il ne peut PAS supprimer le groupe des autres (404)", r.status === 404, String(r.status))
  verifie("le groupe existe toujours", (await prisma.conversation.count({ where: { id: G } })) === 1)

  titre("② A le réintègre")
  r = await appel(A, `/api/conversations/${G}/members`, {
    method: "POST",
    body: JSON.stringify({ publicNumbers: [B.user.publicNumber] }),
  })
  verifie("réintégration acceptée", r.ok, `${r.status} ${await r.clone().text()}`)
  l = await ligne(G, B.user.id)
  verifie("sa ligne est RÉACTIVÉE", l?.estMembre === true && l.quitteLe === null && l.excluPar === null, JSON.stringify(l))
  verifie("pas de doublon", (await prisma.participant.count({ where: { convId: G, userId: B.user.id } })) === 1)
  r = await appel(B, `/api/conversations/${G}/messages`)
  verifie("il relit les messages", r.ok, String(r.status))

  titre("③ A exclut C")
  r = await appel(A, `/api/conversations/${G}/members?userId=${C.user.id}`, { method: "DELETE" })
  verifie("exclusion acceptée", r.ok, `${r.status} ${await r.clone().text()}`)
  l = await ligne(G, C.user.id)
  verifie("exclu_par = A", l?.estMembre === false && l.excluPar === A.user.id, JSON.stringify(l))
  const avant = l?.unreadCount ?? 0
  r = await appel(A, `/api/conversations/${G}/messages`, { method: "POST", body: JSON.stringify({ content: "après l'exclusion" }) })
  verifie("A écrit", r.ok, `${r.status} ${await r.clone().text()}`)
  verifie("C ne reçoit pas de non-lu", (await ligne(G, C.user.id))?.unreadCount === avant)
  verifie("B, lui, en reçoit un", ((await ligne(G, B.user.id))?.unreadCount ?? 0) >= 1)

  titre("④ un administrateur parti")
  await prisma.participant.update({ where: { convId_userId: { convId: G, userId: B.user.id } }, data: { role: "ADMIN" } })
  r = await appel(B, `/api/conversations/${G}/leave`, { method: "POST" })
  verifie("B (admin) part", r.ok, String(r.status))
  r = await appel(B, `/api/conversations/${G}/members`, {
    method: "POST",
    body: JSON.stringify({ publicNumbers: [C.user.publicNumber] }),
  })
  verifie("il ne peut plus ajouter personne (403)", r.status === 403, String(r.status))
} finally {
  await prisma.conversation.delete({ where: { id: G } }).catch(() => undefined)
  await prisma.$disconnect()
}

console.log(`\n${echecs === 0 ? "Tous les contrôles passent." : `${echecs} ÉCHEC(S).`}`)
process.exit(echecs === 0 ? 0 : 1)
