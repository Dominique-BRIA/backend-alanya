/**
 * Prepare la base de DEV pour le banc d'essai des appels :
 * deux comptes au mot de passe connu, inscrits l'un chez l'autre comme contacts.
 *
 * Ne touche QUE `alanya_dev` (voir DATABASE_URL du .env local).
 * Ecrit `banc-comptes.json`, que le banc Playwright relit.
 */
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"
import { writeFileSync } from "node:fs"

const prisma = new PrismaClient()
const MOT_DE_PASSE = "BancEssai2026!"

const tous = await prisma.user.findMany({
  select: { id: true, publicNumber: true, pseudo: true, email: true },
})

// La connexion n'accepte qu'un numero public de 6 ou 8 chiffres.
const valides = tous.filter((u) => /^\d{6}$|^\d{8}$/.test(u.publicNumber ?? "")).slice(0, 2)
if (valides.length < 2) {
  console.error("pas assez de comptes au numero public valide dans la base de dev")
  process.exit(1)
}

const hash = await bcrypt.hash(MOT_DE_PASSE, 10)
for (const u of valides) {
  await prisma.user.update({ where: { id: u.id }, data: { passwordHash: hash } })
}

// Chacun doit voir l'autre dans son repertoire : l'ecran « nouvel appel » ne
// propose que des contacts enregistres.
const [a, b] = valides
for (const [proprietaire, autre] of [
  [a, b],
  [b, a],
]) {
  await prisma.contact.upsert({
    where: { userId_contactId: { userId: proprietaire.id, contactId: autre.id } },
    update: { isBlocked: false },
    create: { userId: proprietaire.id, contactId: autre.id, alias: autre.pseudo ?? "Banc" },
  })
}

// Aucun appel en cours ne doit trainer : un compte « occupe » refuserait l'essai.
await prisma.call.updateMany({
  where: { status: { in: ["RINGING", "ONGOING"] } },
  data: { status: "ENDED", endedAt: new Date() },
})

const fiche = {
  motDePasse: MOT_DE_PASSE,
  a: { id: a.id, numero: a.publicNumber, nom: a.pseudo ?? a.email ?? "" },
  b: { id: b.id, numero: b.publicNumber, nom: b.pseudo ?? b.email ?? "" },
}
writeFileSync("banc-comptes.json", JSON.stringify(fiche, null, 2))
console.log(JSON.stringify(fiche, null, 2))
await prisma.$disconnect()
