/**
 * CE QUE LA BASE SAIT D'UNE CONVERSATION CHIFFRÉE.
 *
 * 🔴 CE SCRIPT NE PROUVE RIEN À LUI SEUL — c'est un HUBLOT, pas un banc d'essai.
 * Il montre, ligne par ligne, ce qu'un administrateur de la base verrait s'il
 * ouvrait la table. C'est exactement le point de vue qui compte : le
 * chiffrement de bout en bout ne vaut que si CE regard-là ne comprend rien.
 *
 * Usage :
 *   node --env-file=.env scripts/e2ee-voir.mjs alice bob
 *   node --env-file=.env scripts/e2ee-voir.mjs doms dominique
 *
 * Les deux arguments cherchent dans le nom, l'e-mail et le numéro public. Un
 * fragment suffit.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/* ══════════════════ MISE EN FORME ══════════════════ */

const gris = (t) => `\x1b[90m${t}\x1b[0m`;
const gras = (t) => `\x1b[1m${t}\x1b[0m`;
const vert = (t) => `\x1b[32m${t}\x1b[0m`;
const rouge = (t) => `\x1b[31m${t}\x1b[0m`;
const jaune = (t) => `\x1b[33m${t}\x1b[0m`;

function titre(n, texte) {
  console.log(`\n${gras(`${n} ${texte}`)}`);
  console.log(gris("─".repeat(72)));
}

function court(id) {
  return typeof id === "string" ? id.slice(0, 8) : String(id);
}

function quand(d) {
  if (!d) return gris("—");
  return new Date(d).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });
}

/* ══════════════════ TROUVER LES DEUX COMPTES ══════════════════ */

async function trouve(fragment) {
  const gens = await prisma.user.findMany({
    where: {
      OR: [
        { nom: { contains: fragment, mode: "insensitive" } },
        { email: { contains: fragment, mode: "insensitive" } },
        { publicNumber: { contains: fragment, mode: "insensitive" } },
      ],
    },
    select: { id: true, nom: true, email: true, publicNumber: true, typeCompte: true },
    take: 10,
  });
  if (gens.length === 0) throw new Error(`Personne ne correspond à « ${fragment} »`);
  if (gens.length > 1) {
    console.log(rouge(`\n« ${fragment} » correspond à ${gens.length} comptes :`));
    for (const g of gens) {
      console.log(`  · ${g.nom ?? "(sans nom)"} — ${g.email ?? "(sans e-mail)"} — ${g.publicNumber ?? ""}`);
    }
    throw new Error("Précisez le fragment.");
  }
  return gens[0];
}

/* ══════════════════ LE HUBLOT ══════════════════ */

async function main() {
  const [fragA, fragB] = process.argv.slice(2);
  if (!fragA || !fragB) {
    console.error("Usage : node --env-file=.env scripts/e2ee-voir.mjs <qui> <qui>");
    process.exit(1);
  }

  const a = await trouve(fragA);
  const b = await trouve(fragB);

  /* ── ① LES DEUX COMPTES ─────────────────────────────────────────── */
  titre("①", "Les deux comptes");
  for (const p of [a, b]) {
    /*
     * ⚠️ `type_compte` DÉCIDE DU DROIT AU CHIFFREMENT, et c'est une LISTE
     * BLANCHE : seul 0 (compte personnel) est chiffrable. 2 = agent,
     * 3 = numéro de centre d'appel, 4 = centre vocal, 9 = admin, 1 = indocumenté.
     * Voir `src/lib/e2ee-perimetre.ts`.
     */
    const personnel = (p.typeCompte ?? 0) === 0;
    console.log(
      `  ${gras(p.nom ?? "(sans nom)")} ${gris(court(p.id))}\n` +
        `    e-mail       ${p.email ?? gris("—")}\n` +
        `    numéro       ${p.publicNumber ?? gris("—")}\n` +
        `    type_compte  ${p.typeCompte ?? 0} ${personnel ? vert("(personnel → chiffrable)") : rouge("(HORS PÉRIMÈTRE)")}`,
    );
  }

  /* ── ② LA CONVERSATION ──────────────────────────────────────────── */
  titre("②", "La conversation");
  const convs = await prisma.conversation.findMany({
    where: {
      isGroup: false,
      AND: [
        { participants: { some: { userId: a.id } } },
        { participants: { some: { userId: b.id } } },
      ],
    },
    select: { id: true, e2eeActif: true, createdAt: true, lastMessage: true },
    orderBy: { createdAt: "asc" },
  });

  if (convs.length === 0) {
    console.log(rouge("  Aucune conversation directe entre ces deux comptes."));
    await prisma.$disconnect();
    return;
  }
  if (convs.length > 1) {
    console.log(
      jaune(`  ⚠️ ${convs.length} fils distincts vers la même personne — des doublons.`),
    );
  }

  for (const c of convs) {
    console.log(
      `  ${gris(court(c.id))}  créé le ${quand(c.createdAt)}\n` +
        `    e2ee_actif   ${c.e2eeActif ? vert("true  ← le fil est chiffré") : gris("false (fil ordinaire)")}\n` +
        /*
         * ⚠️ `lastMessage` EST L'APERÇU DE LA LISTE DES CONVERSATIONS, et c'est
         * un endroit où du clair pourrait fuiter sans qu'on y pense : il est
         * écrit par le serveur, qui ne lit pas les messages chiffrés. Il doit
         * donc rester vide — ou porter le texte d'AVANT le chiffrement.
         */
        `    lastMessage  ${c.lastMessage ? jaune(JSON.stringify(c.lastMessage.slice(0, 60))) : gris("(vide)")}`,
    );
  }

  const conv = convs[convs.length - 1];

  /* ── ③ LES IDENTITÉS PUBLIÉES ───────────────────────────────────── */
  titre("③", "Les identités publiées — un jeu de clés par APPAREIL");
  for (const p of [a, b]) {
    const identites = await prisma.e2eeIdentite.findMany({
      where: { userId: p.id },
      select: {
        deviceId: true,
        registrationId: true,
        cleIdentite: true,
        derniereReleve: true,
        createdAt: true,
        _count: { select: { prekeysUniques: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    console.log(`  ${gras(p.nom ?? court(p.id))} — ${identites.length} appareil(s)`);
    if (identites.length === 0) {
      console.log(rouge("    aucune : ce compte ne peut RIEN recevoir de chiffré"));
    }
    if (identites.length > 1) {
      console.log(
        jaune(
          "    ⚠️ PLUSIEURS IDENTITÉS. Chaque message part en autant d'exemplaires.\n" +
            "       Un appareil qui n'existe plus rend son exemplaire illisible à jamais.",
        ),
      );
    }
    for (const i of identites) {
      const muet = i.derniereReleve === null;
      console.log(
        `    device_id ${gras(String(i.deviceId))}  registration ${i.registrationId}\n` +
          `      clé publique    ${gris(i.cleIdentite.slice(0, 44) + "…")}\n` +
          `      pré-clés restantes ${i._count.prekeysUniques}` +
          (i._count.prekeysUniques === 0 ? rouge("  ← épuisées, il faut republier") : "") +
          `\n      publiée le      ${quand(i.createdAt)}\n` +
          `      dernière relève ${muet ? jaune("jamais") : quand(i.derniereReleve)}`,
      );
    }
  }

  /* ── ④ LES MESSAGES DU FIL ──────────────────────────────────────── */
  titre("④", "Les messages — ce que la colonne `content` contient VRAIMENT");
  const messages = await prisma.message.findMany({
    where: { convId: conv.id },
    select: {
      id: true,
      senderId: true,
      content: true,
      type: true,
      createdAt: true,
      _count: { select: { e2eeEnveloppes: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 40,
  });

  const nom = (id) => (id === a.id ? (a.nom ?? "A") : id === b.id ? (b.nom ?? "B") : court(id));

  if (messages.length === 0) console.log(gris("  (aucun message)"));
  for (const m of messages) {
    const enTransit = m._count.e2eeEnveloppes > 0;
    const vide = (m.content ?? "").trim() === "";
    /*
     * 🔴 C'EST ICI QUE TOUT SE JOUE — ET IL Y A UN CAS QUE J'AI D'ABORD MAL LU.
     *
     * · content vide, enveloppes > 0  → chiffré, EN TRANSIT. Le texte existe
     *                                   encore quelque part, sous clé.
     *
     * · content vide, enveloppes = 0  → chiffré, ENVELOPPES CONSOMMÉES. Et
     *   c'est l'état LE PLUS FORT de tous : le destinataire a relevé, acquitté,
     *   et l'enveloppe a été SUPPRIMÉE. Il ne reste plus rien du texte nulle
     *   part sur le serveur. Même nous ne pourrions pas le retrouver.
     *
     *   🐛 Je l'avais d'abord étiqueté « en clair » — parce que vide et sans
     *   enveloppe ressemble à un message ordinaire. C'était exactement à
     *   l'envers : ce n'est pas l'absence de chiffrement, c'est son ABOUTISSEMENT.
     *
     * · content non vide, enveloppes = 0 → en clair. Normal AVANT l'activation.
     *
     * · content non vide, enveloppes > 0 → 🔴 UNE FUITE. Le texte est en base ET
     *   dans une enveloppe. C'est le trou bouché côté WebSocket le 22/09/2026 ;
     *   si cette ligne reparaît, un troisième chemin d'écriture existe.
     *
     * ⚠️ ON NE JUGE QUE LE TEXTE. Un média ou un message système n'a
     * légitimement pas de `content` : le compter comme chiffré serait se
     * rassurer à bon compte.
     */
    const etat =
      m.type !== "TEXT" ? gris(`${m.type} (non chiffré — chantier remis)`)
      : !vide && enTransit ? rouge("🔴 CHIFFRÉ MAIS LE CLAIR EST EN BASE — FUITE")
      : !vide ? gris("en clair")
      : enTransit ? vert("CHIFFRÉ · en transit")
      : vert("CHIFFRÉ · enveloppes consommées, il ne reste RIEN");

    console.log(
      `  ${quand(m.createdAt)}  ${gras(nom(m.senderId).padEnd(12))} ${etat}\n` +
        `    content  ${vide ? gris("NULL / vide") : JSON.stringify(m.content)}\n` +
        `    enveloppes ${m._count.e2eeEnveloppes}  ${gris(court(m.id))}`,
    );
  }

  /* ── ⑤ LES ENVELOPPES ───────────────────────────────────────────── */
  titre("⑤", "Les enveloppes — le texte, et il est illisible");
  const enveloppes = await prisma.e2eeEnveloppe.findMany({
    where: { convId: conv.id },
    select: {
      id: true,
      expediteurId: true,
      expediteurDevice: true,
      destinataireId: true,
      destinataireDevice: true,
      type: true,
      corps: true,
      messageId: true,
      createdAt: true,
      remisLe: true,
    },
    orderBy: { createdAt: "asc" },
    take: 40,
  });

  if (enveloppes.length === 0) console.log(gris("  (aucune enveloppe)"));
  for (const e of enveloppes) {
    /*
     * ⚠️ LE TYPE EST CONTRE-INTUITIF, et il nous a coûté une erreur :
     * 3 = PreKeyWhisperMessage (OUVRE la session), 1 = WhisperMessage (la suite).
     * Hérité de `libsignal-protocol-javascript`, pas de nous.
     */
    const quoi = e.type === 3 ? "3 = ouvre la session" : e.type === 1 ? "1 = message suivant" : `${e.type} = ?`;
    console.log(
      `  ${quand(e.createdAt)}  ${nom(e.expediteurId)} (appareil ${e.expediteurDevice})` +
        ` → ${nom(e.destinataireId)} (appareil ${e.destinataireDevice})\n` +
        `    type      ${quoi}\n` +
        `    corps     ${gris(e.corps.slice(0, 56) + "…")} ${gris(`(${e.corps.length} car.)`)}\n` +
        `    message   ${e.messageId ? gris(court(e.messageId)) : rouge("ORPHELINE — rattachée à aucun message")}\n` +
        `    état      ${e.remisLe ? gris(`relevée le ${quand(e.remisLe)}`) : vert("EN ATTENTE")}`,
    );
  }

  /* ── ⑥ LE VERDICT ───────────────────────────────────────────────── */
  titre("⑥", "Ce que le serveur peut lire");
  const textes = messages.filter((m) => m.type === "TEXT");
  const enClair = textes.filter((m) => (m.content ?? "").trim() !== "");
  const chiffres = textes.filter((m) => (m.content ?? "").trim() === "");
  const fuites = textes.filter(
    (m) => (m.content ?? "").trim() !== "" && m._count.e2eeEnveloppes > 0,
  );
  const orphelines = enveloppes.filter((e) => e.messageId === null);
  const enAttente = enveloppes.filter((e) => e.remisLe === null);

  console.log(`  messages texte               ${textes.length}`);
  console.log(`    dont en clair              ${enClair.length}`);
  console.log(`    dont chiffrés              ${chiffres.length}`);
  console.log(
    `  clair ET chiffré à la fois   ${fuites.length === 0 ? vert("0  ← c'est la bonne réponse") : rouge(`${fuites.length}  🔴`)}`,
  );
  console.log(`  enveloppes en attente        ${enAttente.length}`);
  console.log(
    `  enveloppes orphelines        ${orphelines.length === 0 ? vert("0") : jaune(`${orphelines.length}  (déposées sans message, illisibles)`)}`,
  );

  console.log(
    "\n  " +
      (fuites.length === 0
        ? vert("✅ Le serveur voit QUI écrit à QUI et QUAND. Pas ce qui est dit.")
        : rouge("🔴 Du texte en clair coexiste avec son chiffré. Un chemin d'écriture échappe aux gardes.")),
  );

  console.log(
    gris(
      "\n  ⚠️ Ce qui reste visible, et qui n'est PAS protégé par le chiffrement :\n" +
        "     les participants, l'horodatage, la taille, la fréquence — les métadonnées.\n" +
        "     Signal ne les protège pas non plus. Le dire est plus honnête que le taire.\n",
    ),
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(rouge(`\n💥 ${e.message}`));
  await prisma.$disconnect();
  process.exit(1);
});
