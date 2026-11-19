/**
 * LES NOTIFICATIONS DES iPHONE (19/11/2026).
 *
 *   ① l'enregistrement d'un jeton `ios` et d'un jeton `ios_voip` ;
 *   ② `tokensForUser` (Firebase) n'emporte JAMAIS un jeton VoIP ;
 *   ③ la forme des envois iOS : visible pour un message et pour un appel
 *     (secours), réveil discret pour une annulation ;
 *   ④ les liens universels : 404 tant que l'équipe Apple n'est pas réglée ;
 *   ⑤ l'envoi VoIP : sans réglages, rien ne part ; avec une clé d'essai, la
 *     requête HTTP/2 atteint vraiment Apple, qui refuse la clé (403).
 *
 * ⚠️ JAMAIS SUR LA BASE DE PRODUCTION : il refuse toute base autre que
 * `alanya_banc` ou `alanya_dev`.
 *
 * Usage : API_URL=http://127.0.0.1:3100 node scripts/ios-push-banc.mjs
 */
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { chargeIos, tokensForUser } from "../push.mjs";

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
const MDP = "MotDePasseDeTest!2026";

async function main() {
  console.log("\n\x1b[1m════ iPHONE : JETONS, ENVOIS, LIENS, VoIP ════\x1b[0m");

  const email = "ios-banc@e2ee.test";
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: await bcrypt.hash(MDP, 10), emailVerified: true, typeCompte: 0 },
    create: {
      email,
      nom: "iPhone Banc",
      passwordHash: await bcrypt.hash(MDP, 10),
      publicNumber: `${Math.floor(10000000 + Math.random() * 89999999)}`,
      emailVerified: true,
      typeCompte: 0,
    },
  });
  await prisma.pushDevice.deleteMany({ where: { userId: user.id } });
  const deviceId = `ios-banc-${user.id.slice(0, 8)}`;
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password: MDP, deviceId, typeDevice: 2 }),
  });
  if (!r.ok) throw new Error(`login → ${r.status} ${await r.text()}`);
  const jeton = (await r.json()).accessToken;

  titre("① Enregistrer les jetons d'un iPhone");
  const enregistrer = (token, platform) =>
    fetch(`${API}/api/push/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jeton}` },
      body: JSON.stringify({ token, platform, deviceId }),
    });
  const jetonFcm = `fcm-ios-${crypto.randomBytes(8).toString("hex")}`;
  const jetonVoip = crypto.randomBytes(32).toString("hex");
  const e1 = await enregistrer(jetonFcm, "ios");
  verifie("jeton Firebase de l'iPhone (ios) : 200", e1.status === 200, `HTTP ${e1.status}`);
  const e2 = await enregistrer(jetonVoip, "ios_voip");
  verifie("jeton des appels (ios_voip) : 200", e2.status === 200, `HTTP ${e2.status} ${await e2.text()}`);
  const e3 = await enregistrer("x".repeat(20), "symbian");
  verifie("une plateforme inconnue est refusée", e3.status === 400, `HTTP ${e3.status}`);

  titre("② Firebase n'emporte jamais un jeton VoIP");
  const jetons = await tokensForUser(prisma, user.id);
  verifie("le jeton ios est là", jetons.includes(jetonFcm), JSON.stringify(jetons));
  verifie("le jeton ios_voip n'y est pas", !jetons.includes(jetonVoip), JSON.stringify(jetons));

  titre("③ La forme des envois iOS");
  const message = chargeIos({ title: "Awa", body: "Nouveau message", data: { type: "message", convId: "c1" }, dataOnly: false });
  verifie(
    "message : notification visible, alerte, mutable-content, fil de la discussion",
    message.notification?.title === "Awa" &&
      message.apns.headers["apns-push-type"] === "alert" &&
      message.apns.payload.aps["mutable-content"] === 1 &&
      message.apns.payload.aps["thread-id"] === "c1",
    JSON.stringify(message),
  );
  const appel = chargeIos({
    title: "Appel entrant",
    body: "Awa · Audio",
    data: { type: "incoming_call", title: "Appel entrant", body: "Awa · Audio" },
    dataOnly: true,
    ttlMs: 90_000,
  });
  verifie(
    "appel sans VoIP : notification visible, avec expiration",
    appel.notification?.body === "Awa · Audio" && Boolean(appel.apns.headers["apns-expiration"]),
    JSON.stringify(appel),
  );
  const annulation = chargeIos({ title: "", body: "", data: { type: "call_cancelled", callId: "x" }, dataOnly: true });
  verifie(
    "annulation : réveil discret (background, content-available), rien d'affiché",
    !annulation.notification &&
      annulation.apns.headers["apns-push-type"] === "background" &&
      annulation.apns.payload.aps["content-available"] === 1,
    JSON.stringify(annulation),
  );

  titre("④ Les liens universels");
  const aasa = await fetch(`${API}/.well-known/apple-app-site-association`);
  verifie(
    "sans équipe Apple réglée : 404 (iOS ignore les liens, rien ne casse)",
    process.env.APPLE_TEAM_ID || process.env.APNS_TEAM_ID ? aasa.status === 200 : aasa.status === 404,
    `HTTP ${aasa.status}`,
  );

  titre("⑤ L'envoi VoIP");
  for (const cle of ["APNS_TEAM_ID", "APNS_KEY_ID", "APNS_CLE_P8", "APNS_CLE_P8_CHEMIN"]) delete process.env[cle];
  const voip = await import("../apns-voip.mjs");
  verifie("sans réglages : non configuré", voip.voipConfigure() === false);
  const rien = await voip.envoyerVoip([jetonVoip], { type: "incoming_call" });
  verifie("sans réglages : rien ne part", rien.servis === 0 && rien.refus.length === 0, JSON.stringify(rien));

  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.APNS_TEAM_ID = "ABCDE12345";
  process.env.APNS_KEY_ID = "KEY1234567";
  process.env.APNS_CLE_P8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "\\n");
  process.env.APNS_SANDBOX = "1";
  verifie("avec une clé d'essai : configuré", voip.voipConfigure() === true);
  const essai = await voip.envoyerVoip([jetonVoip], { type: "incoming_call", callId: crypto.randomUUID() });
  const refus = essai.refus[0];
  verifie(
    "Apple répond (HTTP/2 et jeton JWT bien formés) et refuse la clé d'essai : 403",
    refus?.statut === 403,
    JSON.stringify(essai),
  );

  await prisma.pushDevice.deleteMany({ where: { userId: user.id } });
  console.log(
    echecs === 0
      ? "\n\x1b[32m✓ Tout est conforme.\x1b[0m\n"
      : `\n\x1b[31m✗ ${echecs} vérification(s) en échec.\x1b[0m\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    echecs++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(echecs === 0 ? 0 : 1);
  });
