/**
 * LE RENVOI PAR L'EXPÉDITEUR (piste B, 15/11/2026) — routes `api/e2ee/renvois`.
 *
 * Le scénario : Bob n'avait qu'un téléphone (appareil 1). Alice lui écrit ;
 * le téléphone disparaît sans avoir relevé. Bob se connecte sur un NOUVEL
 * appareil (2), qui demande ce qui lui manque ; un appareil d'Alice sert.
 *
 *   ① le nouvel appareil obtient une demande par message perdu, et seulement
 *     pour ceux-là (ni relevés ailleurs, ni déjà reçus, ni les miens, ni à
 *     vue unique, ni supprimés, ni hors fil chiffré à deux, ni trop vieux) ;
 *   ② demander deux fois ne crée rien de plus ;
 *   ③ un appareil inconnu du compte ne peut rien demander ;
 *   ④ seul l'expéditeur voit ses demandes ;
 *   ⑤ servir dépose l'enveloppe pour le SEUL appareil demandeur, sous le même
 *     message, et ne se sert qu'une fois ;
 *   ⑥ un tiers ne peut pas servir, ni un message supprimé entre-temps ;
 *   ⑦ une enveloppe mal formée est refusée ;
 *   ⑧ sans connexion, tout est refusé.
 *
 * ⚠️ JAMAIS SUR LA BASE DE PRODUCTION : il crée et efface des comptes. Il
 * refuse de tourner si la base ne s'appelle pas `alanya_banc` ou `alanya_dev`.
 *
 * Usage : node --env-file=.env.banc scripts/e2ee-renvois-banc.mjs
 *         (API démarrée sur cette base ; API_URL, par défaut :3000)
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const API = process.env.API_URL ?? "http://localhost:3000";

const base = (process.env.DATABASE_URL ?? "").split("?")[0].split("/").pop();
if (base !== "alanya_banc" && base !== "alanya_dev") {
  console.error(`\x1b[31mRefusé : la base « ${base} » n'est pas une base de test.\x1b[0m`);
  process.exit(2);
}

const prisma = new PrismaClient();
let echecs = 0;

function verifie(libelle, condition, detail) {
  console.log(`  ${condition ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${libelle}`);
  if (!condition) {
    echecs++;
    if (detail !== undefined) console.log(`      \x1b[31m${detail}\x1b[0m`);
  }
}
const titre = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

async function compte(marque) {
  const email = `renvoi-${marque}@e2ee.test`;
  const motDePasse = "MotDePasseDeTest!2026";
  const hash = await bcrypt.hash(motDePasse, 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, emailVerified: true, typeCompte: 0 },
    create: {
      email,
      nom: `Renvoi ${marque}`,
      passwordHash: hash,
      publicNumber: `${Math.floor(10000000 + Math.random() * 89999999)}`,
      emailVerified: true,
      typeCompte: 0,
    },
  });
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password: motDePasse, deviceId: `renvoi-${marque}`, typeDevice: 0 }),
  });
  if (!r.ok) throw new Error(`login ${marque} → ${r.status} ${await r.text()}`);
  return { user, jeton: (await r.json()).accessToken };
}

async function appareil(qui, deviceId) {
  await prisma.e2eeIdentite.create({
    data: { userId: qui.user.id, deviceId, registrationId: deviceId, cleIdentite: `cle-${deviceId}` },
  });
}

async function fil(a, b, { chiffre = true, groupe = false } = {}) {
  const c = await prisma.conversation.create({
    data: {
      isGroup: groupe,
      e2eeActif: chiffre,
      participants: { create: [{ userId: a.user.id }, { userId: b.user.id }] },
    },
    select: { id: true },
  });
  return c.id;
}

/** Un message d'[auteur] chiffré pour [pour] (appareils), éventuellement relevé. */
async function message(convId, auteur, pour, appareils, options = {}) {
  const m = await prisma.message.create({
    data: {
      convId,
      senderId: auteur.user.id,
      content: null,
      type: "TEXT",
      status: "SENT",
      vueUnique: options.vueUnique ?? false,
      ...(options.vieux ? { createdAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) } : {}),
      ...(options.supprime ? { deletedAt: new Date() } : {}),
    },
    select: { id: true },
  });
  for (const d of appareils) {
    await prisma.e2eeEnveloppe.create({
      data: {
        convId,
        expediteurId: auteur.user.id,
        expediteurDevice: 1,
        destinataireId: pour.user.id,
        destinataireDevice: d,
        type: 1,
        corps: "QUJDRA==",
        messageId: m.id,
        remisLe: options.releve ? new Date() : null,
      },
    });
  }
  return m.id;
}

async function appel(qui, methode, chemin, corps) {
  const r = await fetch(`${API}${chemin}`, {
    method: methode,
    headers: {
      "Content-Type": "application/json",
      ...(qui ? { Authorization: `Bearer ${qui.jeton}` } : {}),
    },
    ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
  });
  const texte = await r.text();
  let json = null;
  try {
    json = JSON.parse(texte);
  } catch {}
  return { statut: r.status, json, texte };
}

async function nettoyer(comptes) {
  const ids = comptes.map((c) => c.user.id);
  await prisma.e2eeRenvoi.deleteMany({ where: { OR: [{ expediteurId: { in: ids } }, { demandeurId: { in: ids } }] } });
  const convs = await prisma.participant.findMany({ where: { userId: { in: ids } }, select: { convId: true } });
  await prisma.conversation.deleteMany({ where: { id: { in: convs.map((c) => c.convId) } } });
  await prisma.e2eeIdentite.deleteMany({ where: { userId: { in: ids } } });
}

async function main() {
  console.log("\n\x1b[1m════ LE RENVOI PAR L'EXPÉDITEUR (piste B) ════\x1b[0m");
  const alice = await compte("alice");
  const bob = await compte("bob");
  const carole = await compte("carole");
  await nettoyer([alice, bob, carole]);

  await appareil(alice, 1);
  await appareil(bob, 1); // l'ancien téléphone, perdu
  await appareil(bob, 2); // le nouvel appareil
  await appareil(carole, 1);

  const ab = await fil(alice, bob);
  const perdu1 = await message(ab, alice, bob, [1]);
  const perdu2 = await message(ab, alice, bob, [1]);
  // Ce qui ne doit PAS être demandé :
  await message(ab, alice, bob, [1], { releve: true }); //   relevé par l'ancien
  await message(ab, alice, bob, [1, 2]); //                   déjà chiffré pour le nouveau
  await message(ab, bob, alice, [1]); //                      écrit par Bob lui-même
  await message(ab, alice, bob, [1], { vueUnique: true }); // à vue unique
  await message(ab, alice, bob, [1], { supprime: true }); //  supprimé
  await message(ab, alice, bob, [1], { vieux: true }); //     plus de 30 jours
  const clair = await fil(alice, bob, { chiffre: false });
  await message(clair, alice, bob, [1]); //                    fil non chiffré
  const groupe = await fil(alice, bob, { groupe: true });
  await message(groupe, alice, bob, [1]); //                   groupe

  titre("① Le nouvel appareil demande ce qui lui manque, et rien d'autre");
  const r1 = await appel(bob, "POST", "/api/e2ee/renvois", { deviceId: 2 });
  verifie("accepté", r1.statut === 200, `HTTP ${r1.statut} ${r1.texte.slice(0, 160)}`);
  const demandes = await prisma.e2eeRenvoi.findMany({ where: { demandeurId: bob.user.id } });
  verifie(
    "exactement les deux messages perdus",
    demandes.length === 2 && new Set(demandes.map((d) => d.messageId)).size === 2 &&
      demandes.every((d) => [perdu1, perdu2].includes(d.messageId)),
    JSON.stringify(demandes.map((d) => d.messageId)),
  );
  verifie(
    "attribuées à Alice, pour l'appareil 2",
    demandes.every((d) => d.expediteurId === alice.user.id && d.demandeurDevice === 2 && d.convId === ab),
  );

  titre("② Demander deux fois ne crée rien de plus");
  const r2 = await appel(bob, "POST", "/api/e2ee/renvois", { deviceId: 2 });
  verifie(
    "aucune nouvelle demande",
    r2.statut === 200 && (await prisma.e2eeRenvoi.count({ where: { demandeurId: bob.user.id } })) === 2,
    r2.texte.slice(0, 160),
  );

  titre("③ Un appareil inconnu du compte ne peut rien demander");
  const r3 = await appel(bob, "POST", "/api/e2ee/renvois", { deviceId: 999 });
  verifie("refusé (404)", r3.statut === 404, `HTTP ${r3.statut}`);
  const r3b = await appel(bob, "POST", "/api/e2ee/renvois", { deviceId: "2" });
  verifie("un deviceId qui n'est pas un entier est refusé (400)", r3b.statut === 400, `HTTP ${r3b.statut}`);

  titre("④ Seul l'expéditeur voit ses demandes");
  const vuesAlice = await appel(alice, "GET", "/api/e2ee/renvois");
  verifie(
    "Alice voit les deux",
    vuesAlice.statut === 200 && vuesAlice.json?.demandes?.length === 2,
    vuesAlice.texte.slice(0, 160),
  );
  const vuesCarole = await appel(carole, "GET", "/api/e2ee/renvois");
  verifie("Carole n'en voit aucune", vuesCarole.json?.demandes?.length === 0, vuesCarole.texte.slice(0, 160));

  titre("⑤ Servir dépose pour le seul appareil demandeur, une seule fois");
  const d1 = vuesAlice.json.demandes.find((d) => d.messageId === perdu1);
  const avant = await prisma.e2eeEnveloppe.count({ where: { messageId: perdu1 } });
  const s1 = await appel(alice, "POST", "/api/e2ee/renvois/servir", {
    id: d1.id, deviceId: 1, type: 3, corps: "UkVOVk9J",
  });
  verifie("servi (201)", s1.statut === 201, `HTTP ${s1.statut} ${s1.texte.slice(0, 160)}`);
  const deposees = await prisma.e2eeEnveloppe.findMany({
    where: { messageId: perdu1, destinataireDevice: 2 },
  });
  verifie(
    "une enveloppe neuve, pour Bob appareil 2, sous le même message",
    deposees.length === 1 &&
      deposees[0].destinataireId === bob.user.id &&
      deposees[0].expediteurId === alice.user.id &&
      deposees[0].corps === "UkVOVk9J" &&
      deposees[0].type === 3 &&
      deposees[0].remisLe === null &&
      (await prisma.e2eeEnveloppe.count({ where: { messageId: perdu1 } })) === avant + 1,
    JSON.stringify(deposees),
  );
  const s1b = await appel(alice, "POST", "/api/e2ee/renvois/servir", {
    id: d1.id, deviceId: 1, type: 1, corps: "QVVUUkU=",
  });
  verifie(
    "la servir encore ne dépose rien (deja: true)",
    s1b.json?.deja === true && (await prisma.e2eeEnveloppe.count({ where: { messageId: perdu1 } })) === avant + 1,
    s1b.texte.slice(0, 160),
  );
  const restantes = await appel(alice, "GET", "/api/e2ee/renvois");
  verifie("elle sort de la liste d'Alice", restantes.json?.demandes?.length === 1);
  const releve = await appel(bob, "GET", "/api/e2ee/enveloppes?deviceId=2");
  verifie(
    "et la relève du nouvel appareil la rend",
    releve.json?.enveloppes?.some((e) => e.messageId === perdu1 && e.corps === "UkVOVk9J"),
    releve.texte.slice(0, 200),
  );

  titre("⑥ Un tiers ne sert pas ; un message supprimé non plus");
  const d2 = vuesAlice.json.demandes.find((d) => d.messageId === perdu2);
  const t1 = await appel(carole, "POST", "/api/e2ee/renvois/servir", {
    id: d2.id, deviceId: 1, type: 1, corps: "VElFUlM=",
  });
  verifie("Carole : refusé (404)", t1.statut === 404, `HTTP ${t1.statut}`);
  const t1b = await appel(bob, "POST", "/api/e2ee/renvois/servir", {
    id: d2.id, deviceId: 2, type: 1, corps: "Qk9C",
  });
  verifie("Bob, le demandeur, ne se sert pas lui-même (404)", t1b.statut === 404, `HTTP ${t1b.statut}`);
  await prisma.message.update({ where: { id: perdu2 }, data: { deletedAt: new Date() } });
  const t2 = await appel(alice, "POST", "/api/e2ee/renvois/servir", {
    id: d2.id, deviceId: 1, type: 1, corps: "U1VQUFI=",
  });
  verifie(
    "message supprimé entre-temps : refusé, rien de déposé",
    t2.statut === 404 &&
      (await prisma.e2eeEnveloppe.count({ where: { messageId: perdu2, destinataireDevice: 2 } })) === 0,
    `HTTP ${t2.statut}`,
  );

  titre("⑦ Une enveloppe mal formée est refusée");
  for (const [libelle, corps] of [
    ["type inconnu", { id: d2.id, deviceId: 1, type: 7, corps: "QQ==" }],
    ["corps vide", { id: d2.id, deviceId: 1, type: 1, corps: "" }],
    ["sans id", { deviceId: 1, type: 1, corps: "QQ==" }],
  ]) {
    const r = await appel(alice, "POST", "/api/e2ee/renvois/servir", corps);
    verifie(`${libelle} : 400`, r.statut === 400, `HTTP ${r.statut}`);
  }

  titre("⑧ Sans connexion, tout est refusé");
  for (const [m, c, corps] of [
    ["POST", "/api/e2ee/renvois", { deviceId: 2 }],
    ["GET", "/api/e2ee/renvois", undefined],
    ["POST", "/api/e2ee/renvois/servir", { id: d2.id, deviceId: 1, type: 1, corps: "QQ==" }],
  ]) {
    const r = await appel(null, m, c, corps);
    verifie(`${m} ${c} : 401`, r.statut === 401, `HTTP ${r.statut}`);
  }

  await nettoyer([alice, bob, carole]);
  console.log(
    echecs === 0
      ? "\n\x1b[32m════ Tout passe ════\x1b[0m\n"
      : `\n\x1b[31m════ ${echecs} échec(s) ════\x1b[0m\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    echecs++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exitCode = echecs === 0 ? 0 : 1;
  });
