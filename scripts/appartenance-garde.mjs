/**
 * GARDE-FOU — aucune lecture de l'appartenance sans le filtre des membres
 * ACTIFS (09/10/2026, cours chapitre 33).
 *
 * Depuis `isMembre`, un ancien membre GARDE sa ligne dans `conv_participants`.
 * Toute lecture qui oublie `MEMBRE_ACTIF` (ou `estMembre`) lui servirait la
 * suite : messages, enveloppes, présence, notifications. Il y avait 38
 * lectures dans 16 fichiers ; ce script empêche la 39ᵉ d'oublier.
 *
 * Il cherche :
 *   · `prisma.participant.findMany / findFirst / findUnique / count / updateMany`
 *   · `participants: { some: …`  (filtre de relation)
 * et exige `MEMBRE_ACTIF` ou `estMembre` dans les lignes qui suivent.
 *
 * Lancer : node scripts/appartenance-garde.mjs   (code 1 en cas d'oubli)
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const FENETRE = 8

/**
 * Exceptions JUSTIFIÉES, par fichier et extrait de ligne. Chacune dit pourquoi
 * le filtre n'a pas de sens à cet endroit.
 */
const EXCEPTIONS = [
  // Conversations À DEUX et « Moi » : personne n'en part (le départ est réservé
  // aux groupes), et elles se retrouvent par leurs deux participants.
  { fichier: "src/modules/messaging/access.ts", extrait: "participants: { some: { userId }, every: { userId } }" },
  { fichier: "src/modules/messaging/access.ts", extrait: "{ participants: { some: { userId: userA } } }" },
  { fichier: "src/modules/messaging/access.ts", extrait: "{ participants: { some: { userId: userB } } }" },
  // Participants d'un APPEL et d'une RÉUNION : d'autres modèles, sans départ.
  { fichier: "src/lib/repondeur.mjs", extrait: "participants: { some: { userId: accueil.userId } }" },
  { fichier: "src/app/api/meetings/route.ts", extrait: "participants: { some: { IDparticipant: userId } }" },
]

const MOTIFS = [
  /prisma\.participant\.(findMany|findFirst|findUnique|count|updateMany)\(/,
  /participants:\s*\{\s*some:/,
]

function fichiers(dossier) {
  const sortie = []
  for (const nom of readdirSync(dossier)) {
    const chemin = join(dossier, nom)
    if (statSync(chemin).isDirectory()) sortie.push(...fichiers(chemin))
    else if (/\.(ts|tsx|mjs)$/.test(nom)) sortie.push(chemin)
  }
  return sortie
}

const aVerifier = [...fichiers("src"), "ws-server.mjs"]
const oublis = []
for (const chemin of aVerifier) {
  const relatif = chemin.replaceAll("\\", "/")
  if (relatif === "src/lib/appartenance.mjs") continue
  const lignes = readFileSync(chemin, "utf8").split(/\r?\n/)
  lignes.forEach((ligne, i) => {
    if (!MOTIFS.some((m) => m.test(ligne))) return
    if (EXCEPTIONS.some((e) => e.fichier === relatif && ligne.includes(e.extrait))) return
    const suite = lignes.slice(i, i + FENETRE).join("\n")
    if (/MEMBRE_ACTIF|estMembre/.test(suite)) return
    oublis.push(`${relatif}:${i + 1}  ${ligne.trim()}`)
  })
}

if (oublis.length === 0) {
  console.log(`✓ Aucune lecture de l'appartenance sans le filtre des membres actifs (${aVerifier.length} fichiers).`)
  process.exit(0)
}
console.log(`✗ ${oublis.length} lecture(s) sans MEMBRE_ACTIF :\n`)
for (const o of oublis) console.log("  " + o)
console.log("\nAjouter `...MEMBRE_ACTIF` (src/lib/appartenance.mjs), ou une exception JUSTIFIÉE dans ce script.")
process.exit(1)
