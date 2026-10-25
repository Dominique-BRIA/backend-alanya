/**
 * Remplace les IMAGES d'un pack de stickers déjà publié, sans toucher à ses
 * stickers : mêmes identifiants, même ordre, mêmes favoris et mêmes panneaux
 * chez les utilisateurs. Sert à refaire un pack aux couleurs d'une marque
 * (25/10/2026 : le pack « alanya », logo bleu → logo Alanya Work).
 *
 * Chaque sticker est retrouvé par son nom français (`pack.json`, champ `nom`),
 * comme l'import (`importer-packs-stickers.ts`) l'a rangé. Les images passent
 * par les mêmes règles que la console : type, 1 Mo au plus, stockage public,
 * même fichier = même ligne (empreinte).
 *
 * ⚠️ LES ANCIENNES IMAGES RESTENT : les messages déjà envoyés les citent par
 * leur numéro et les montrent encore. Seuls les NOUVEAUX envois prennent les
 * nouvelles.
 *
 * Usage :
 *   npx tsx --env-file=.env --tsconfig tsconfig.json scripts/remplacer-images-pack.ts \
 *     <dossier du pack> [--nom="Alanya Work"] [--essai]
 *
 * `--essai` : vérifie tout (pack, correspondance, fichiers), n'écrit rien.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { saveBuffer } from "@/modules/media/storage";

type PackJson = {
  code: string;
  nom: Record<string, string>;
  stickers: { fichier: string; nom?: string; emoji?: string }[];
};

const OCTETS_MAX = 1024 * 1024;

async function main() {
  const dossier = process.argv[2];
  if (!dossier) throw new Error("Dossier du pack requis");
  const essai = process.argv.includes("--essai");
  const nouveauNom = process.argv.find((a) => a.startsWith("--nom="))?.slice(6);
  const pack = JSON.parse(readFileSync(join(dossier, "pack.json"), "utf8")) as PackJson;

  const enBase = await prisma.stickerPack.findUnique({
    where: { code: pack.code },
    include: { stickers: { orderBy: { position: "asc" } } },
  });
  if (!enBase) throw new Error(`Pack « ${pack.code} » introuvable`);
  if (enBase.proprietaireId) throw new Error("Pack personnel : refusé");

  const nomFr = (s: { nom: Prisma.JsonValue }) => ((s.nom as Record<string, string> | null)?.fr ?? "").trim();
  const plan: { stickerId: bigint; fichier: string; octets: Buffer; ancien: bigint }[] = [];
  for (const e of pack.stickers) {
    const cible = enBase.stickers.find((s) => nomFr(s) === (e.nom ?? "").trim());
    if (!cible) throw new Error(`Aucun sticker « ${e.nom} » dans le pack`);
    const octets = readFileSync(join(dossier, e.fichier));
    if (octets.length > OCTETS_MAX) throw new Error(`${e.fichier} : plus de 1 Mo`);
    if (octets.toString("latin1", 0, 4) !== "RIFF" || octets.toString("latin1", 8, 12) !== "WEBP") {
      throw new Error(`${e.fichier} : WebP attendu`);
    }
    plan.push({ stickerId: cible.id, fichier: e.fichier, octets, ancien: cible.assetId });
  }
  console.log(`${pack.code} : ${plan.length} sticker(s) sur ${enBase.stickers.length} en base${essai ? " — ESSAI, rien n'est écrit" : ""}`);
  if (essai) {
    for (const p of plan) console.log(`  ${p.fichier} → sticker ${p.stickerId} (image ${p.ancien} remplacée)`);
    return;
  }

  for (const p of plan) {
    const empreinte = createHash("sha256").update(p.octets).digest("hex");
    let asset = await prisma.stickerAsset.findUnique({ where: { empreinte } });
    if (!asset) {
      const { relativeUrl, espace } = await saveBuffer(p.octets, p.fichier, "image/webp", "public");
      asset = await prisma.stickerAsset.create({
        data: { url: relativeUrl, espace: espace === "public" ? "public" : null, mime: "image/webp", octets: p.octets.length, empreinte, anime: false },
      });
    }
    await prisma.sticker.update({ where: { id: p.stickerId }, data: { assetId: asset.id } });
    console.log(`  ${p.fichier} → sticker ${p.stickerId} : image ${p.ancien} → ${asset.id}`);
  }
  await prisma.stickerPack.update({
    where: { id: enBase.id },
    data: {
      modifieLe: new Date(),
      version: { increment: 1 },
      ...(nouveauNom ? { nom: { ...((enBase.nom as Record<string, string>) ?? {}), fr: nouveauNom, en: nouveauNom } } : {}),
    },
  });
  console.log(`Pack « ${pack.code} » mis à jour${nouveauNom ? `, nommé « ${nouveauNom} »` : ""}.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
