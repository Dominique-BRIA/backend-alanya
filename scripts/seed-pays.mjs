/**
 * Seed de la table « pays » — indicatifs téléphoniques et fuseaux horaires.
 * Usage : node --env-file=.env scripts/seed-pays.mjs
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const PAYS = [
  { libelle: "Cameroun", prefix: "+237", timeZone: "Africa/Douala", decalageHoraire: 60 },
  { libelle: "France", prefix: "+33", timeZone: "Europe/Paris", decalageHoraire: 120 },
  { libelle: "Côte d'Ivoire", prefix: "+225", timeZone: "Africa/Abidjan", decalageHoraire: 0 },
  { libelle: "Sénégal", prefix: "+221", timeZone: "Africa/Dakar", decalageHoraire: 0 },
  { libelle: "RD Congo", prefix: "+243", timeZone: "Africa/Kinshasa", decalageHoraire: 60 },
  { libelle: "Gabon", prefix: "+241", timeZone: "Africa/Libreville", decalageHoraire: 60 },
  { libelle: "Tchad", prefix: "+235", timeZone: "Africa/Ndjamena", decalageHoraire: 60 },
  { libelle: "Congo (Brazzaville)", prefix: "+242", timeZone: "Africa/Brazzaville", decalageHoraire: 60 },
  { libelle: "Bénin", prefix: "+229", timeZone: "Africa/Porto-Novo", decalageHoraire: 60 },
  { libelle: "Togo", prefix: "+228", timeZone: "Africa/Lome", decalageHoraire: 0 },
  { libelle: "Mali", prefix: "+223", timeZone: "Africa/Bamako", decalageHoraire: 0 },
  { libelle: "Burkina Faso", prefix: "+226", timeZone: "Africa/Ouagadougou", decalageHoraire: 0 },
  { libelle: "Niger", prefix: "+227", timeZone: "Africa/Niamey", decalageHoraire: 60 },
  { libelle: "Guinée", prefix: "+224", timeZone: "Africa/Conakry", decalageHoraire: 0 },
  { libelle: "Maroc", prefix: "+212", timeZone: "Africa/Casablanca", decalageHoraire: 60 },
  { libelle: "Algérie", prefix: "+213", timeZone: "Africa/Algiers", decalageHoraire: 60 },
  { libelle: "Tunisie", prefix: "+216", timeZone: "Africa/Tunis", decalageHoraire: 60 },
  { libelle: "Nigeria", prefix: "+234", timeZone: "Africa/Lagos", decalageHoraire: 60 },
  { libelle: "Ghana", prefix: "+233", timeZone: "Africa/Accra", decalageHoraire: 0 },
  { libelle: "Canada", prefix: "+1", timeZone: "America/Toronto", decalageHoraire: -240 },
  { libelle: "Belgique", prefix: "+32", timeZone: "Europe/Brussels", decalageHoraire: 120 },
  { libelle: "Suisse", prefix: "+41", timeZone: "Europe/Zurich", decalageHoraire: 120 },
  { libelle: "Allemagne", prefix: "+49", timeZone: "Europe/Berlin", decalageHoraire: 120 },
  { libelle: "Royaume-Uni", prefix: "+44", timeZone: "Europe/London", decalageHoraire: 60 },
  { libelle: "États-Unis", prefix: "+1", timeZone: "America/New_York", decalageHoraire: -300 },
];

async function main() {
  console.log("🌍 Seed de la table « pays »…");

  for (const p of PAYS) {
    const existing = await prisma.pays.findFirst({ where: { libelle: p.libelle } });
    if (!existing) {
      await prisma.pays.create({ data: p });
      console.log(`  ✅ ${p.libelle} (${p.prefix})`);
    } else {
      console.log(`  ⏭️  ${p.libelle} existe déjà`);
    }
  }

  const count = await prisma.pays.count();
  console.log(`\n✅ Total : ${count} pays en base.`);
}

main()
  .catch((e) => {
    console.error("❌ Erreur seed pays :", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
