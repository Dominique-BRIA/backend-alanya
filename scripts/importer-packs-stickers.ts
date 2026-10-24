/**
 * Importe des packs de stickers (dossiers `<code>/pack.json` + images) dans le
 * catalogue de la console, par les MÊMES fonctions que la console
 * (`src/lib/gestion/stickers.ts`) : mêmes contrôles de type et de taille,
 * même stockage public, mêmes fichiers réutilisés par empreinte.
 *
 * Format d'un `pack.json` (livré avec les packs du 24/10/2026) :
 *   { code, nom: { fr }, premium, icone, stickers: [{ fichier, id, nom, emoji }] }
 * `icone` désigne par son `id` le sticker qui sert de vignette.
 *
 * Usage :
 *   npx tsx --env-file=.env --tsconfig tsconfig.json scripts/importer-packs-stickers.ts \
 *     <dossier des packs> [--publier] [--gratuits=royal,autre]
 *
 * Rejouable : un pack dont le code existe déjà est laissé tel quel.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { creerPack, modifierPack, modifierSticker, publierPack, televerser } from "@/lib/gestion/stickers";

type PackJson = {
  code: string;
  nom: Record<string, string>;
  premium?: boolean;
  icone?: string;
  stickers: { fichier: string; id: string; nom?: string; emoji?: string }[];
};

/** Un WebP animé porte le drapeau ANIM (0x02) dans son en-tête VP8X. */
function webpAnime(octets: Buffer): boolean {
  return octets.length > 21 && octets.toString("ascii", 12, 16) === "VP8X" && (octets[20] & 0x02) !== 0;
}

async function main() {
  const dossier = process.argv[2];
  if (!dossier) throw new Error("Dossier des packs requis");
  const publier = process.argv.includes("--publier");
  const gratuits = new Set(
    (process.argv.find((a) => a.startsWith("--gratuits="))?.slice(11) ?? "").split(",").filter(Boolean),
  );

  // Ordre d'affichage : alanya d'abord (la marque), puis l'ordre alphabétique.
  const codes = readdirSync(dossier, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dossier, d.name, "pack.json")))
    .map((d) => d.name)
    .sort((a, b) => (a === "alanya" ? -1 : b === "alanya" ? 1 : a.localeCompare(b)));

  for (const [ordre, code] of codes.entries()) {
    const pack = JSON.parse(readFileSync(join(dossier, code, "pack.json"), "utf8")) as PackJson;
    if (await prisma.stickerPack.findUnique({ where: { code: pack.code } })) {
      console.log(`= ${pack.code} : existe déjà, laissé tel quel`);
      continue;
    }
    const { id } = await creerPack({
      code: pack.code,
      name_i18n: pack.nom,
      is_premium: pack.premium === true && !gratuits.has(pack.code),
      sort_order: ordre,
    });
    const idPack = BigInt(id);
    let couverture: number | null = null;
    let animes = 0;
    for (const s of pack.stickers) {
      const octets = readFileSync(join(dossier, code, s.fichier));
      const form = new FormData();
      form.append("files", new File([octets], s.fichier, { type: "image/webp" }));
      form.append("emoji", s.emoji ?? "");
      const [cree] = await televerser(idPack, form);
      if (s.nom) await modifierSticker(BigInt(cree.id), { name_i18n: { fr: s.nom } });
      // `televerser` ne marque « animé » que les GIF : un WebP animé l'est aussi.
      if (webpAnime(octets)) {
        const st = await prisma.sticker.findUnique({ where: { id: BigInt(cree.id) } });
        if (st) await prisma.stickerAsset.update({ where: { id: st.assetId }, data: { anime: true } });
        animes++;
      }
      if (s.id === pack.icone) couverture = cree.id;
    }
    if (couverture === null) {
      const premier = await prisma.sticker.findFirst({ where: { packId: idPack }, orderBy: { position: "asc" } });
      couverture = premier ? Number(premier.id) : null;
    }
    if (couverture !== null) await modifierPack(idPack, { cover_sticker_id: couverture });
    if (publier) await publierPack(idPack);
    console.log(
      `+ ${pack.code} : ${pack.stickers.length} stickers${animes ? ` (${animes} animés)` : ""}` +
        `${pack.premium && !gratuits.has(pack.code) ? ", premium" : ""}${publier ? ", publié" : ", brouillon"}`,
    );
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
