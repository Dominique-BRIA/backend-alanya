/**
 * LE BANC DU TÉLÉPHONE LIÉ — un compte, un téléphone.
 *
 * Joue les cinq cas de la demande du 28/09/2026, puis les bords :
 *
 *   ① première connexion : le compte se lie au téléphone A ;
 *   ② déconnexion ordinaire : A reste lié, et peut se reconnecter ;
 *   ③ téléphone B : REFUSÉ, et A n'est PAS déconnecté ;
 *   ④ dissociation : le compte redevient libre (simulée en base tant que la
 *      route n'existe pas — lot 3) ;
 *   ⑤ B se connecte après dissociation, et devient le téléphone lié ;
 *   ⑥ deux téléphones au même instant sur un compte libre : UN SEUL passe ;
 *   ⑦ une session d'un téléphone non lié, ouverte avant la règle, est coupée
 *      au rafraîchissement — avec un verdict que les APK installés connaissent ;
 *   ⑧ un « téléphone » sans identifiant est refusé ;
 *   ⑨ l'inscription lie le téléphone ;
 *   ⑩ le web n'est pas concerné.
 *
 * ⚠️ CHAQUE REFUS A SON TÉMOIN : le même geste par le téléphone lié doit
 * passer. Une garde qui refuse tout passerait les refus sans rien protéger.
 *
 * Usage : node --env-file=.env scripts/telephone-lie-banc.mjs
 *         (backend démarré ; API_URL, défaut http://localhost:3000)
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const API = process.env.API_URL ?? "http://localhost:3000";
const prisma = new PrismaClient();
const MOT_DE_PASSE = "banc-telephone-lie";

let echecs = 0;
let ip = 0;

function verifie(libelle, condition, detail) {
  console.log(`  ${condition ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${libelle}`);
  if (!condition) {
    echecs++;
    if (detail !== undefined) console.log(`      \x1b[31m${JSON.stringify(detail)}\x1b[0m`);
  }
}

function titre(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/**
 * Une adresse différente par requête : la connexion est plafonnée à 5 essais
 * par minute et par adresse, et ce banc en fait bien plus.
 */
async function appel(chemin, corps, entetes = {}, methode = "POST") {
  ip++;
  const r = await fetch(`${API}${chemin}`, {
    method: methode,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `10.99.${Math.floor(ip / 250)}.${ip % 250}`,
      ...entetes,
    },
    body: corps === undefined ? undefined : JSON.stringify(corps),
  });
  const json = await r.json().catch(() => ({}));
  return { statut: r.status, code: json?.error?.code ?? json?.code, json };
}

const connexion = (compte, deviceId, typeDevice) =>
  appel("/api/auth/login", {
    identifier: compte.publicNumber,
    password: MOT_DE_PASSE,
    ...(deviceId ? { deviceId } : {}),
    ...(typeDevice !== undefined ? { typeDevice } : {}),
  });

const rafraichir = (refreshToken) => appel("/api/auth/refresh", { refreshToken });
const jetons = (r) => r.json?.data ?? r.json;
const auth = (r) => ({ authorization: `Bearer ${jetons(r).accessToken}` });

/** Ce que la dissociation doit couper : une ligne au registre, un jeton push. */
async function equipe(compte, deviceId, typeDevice = 1) {
  const ligne = await prisma.appareil.create({
    data: { alanyaId: compte.id, cookiesWebId: deviceId, typeDevice, libelle: "Banc" },
  });
  await prisma.pushDevice.create({
    data: {
      userId: compte.id,
      deviceId,
      token: `banc-push-${deviceId}`,
      platform: typeDevice === 0 ? "web" : "android",
    },
  });
  return ligne;
}

const pushDe = (compte, deviceId) =>
  prisma.pushDevice.count({ where: { userId: compte.id, deviceId } });
const ligneDe = (ligne) =>
  prisma.appareil.findUnique({ where: { appareilId: ligne.appareilId } });

async function lie(compte) {
  const u = await prisma.user.findUnique({
    where: { id: compte.id },
    select: { deviceId: true, dissocier: true },
  });
  return u;
}

let numero = 0;
async function nouveauCompte() {
  numero++;
  return prisma.user.create({
    data: {
      publicNumber: `9${String(Date.now()).slice(-6)}${numero}`.slice(0, 8),
      passwordHash: await bcrypt.hash(MOT_DE_PASSE, 4),
      pseudo: `Banc téléphone ${numero}`,
    },
  });
}

const comptes = [];
const A = `mob-bancA${Date.now()}`;
const B = `mob-bancB${Date.now()}`;
const C = `mob-bancC${Date.now()}`;

try {
  const c1 = await nouveauCompte();
  comptes.push(c1);

  titre("① Première connexion");
  verifie("un compte neuf est libre", (await lie(c1)).dissocier === true);
  const a1 = await connexion(c1, A, 1);
  verifie("A se connecte", a1.statut === 200, a1);
  const l1 = await lie(c1);
  verifie("le compte est lié à A", l1.deviceId === A && l1.dissocier === false, l1);

  titre("② Déconnexion ordinaire");
  const deco = await appel("/api/auth/logout", { refreshToken: jetons(a1).refreshToken });
  verifie("A se déconnecte", deco.statut === 200, deco);
  const l2 = await lie(c1);
  verifie("A reste lié après la déconnexion", l2.deviceId === A && !l2.dissocier, l2);
  /*
   * Reconnexion IMMÉDIATE, à dessein : dans la même seconde que la connexion
   * précédente. Avant le `jti` des jetons de rafraîchissement, les deux
   * recevaient le même jeton et la seconde session était refusée.
   */
  const a2 = await connexion(c1, A, 1);
  verifie("A se reconnecte", a2.statut === 200, a2);

  titre("③ Téléphone B");
  const b1 = await connexion(c1, B, 1);
  verifie("B est refusé (409 TELEPHONE_DEJA_ASSOCIE)",
    b1.statut === 409 && b1.code === "TELEPHONE_DEJA_ASSOCIE", b1);
  verifie("le message est celui demandé",
    JSON.stringify(b1.json).includes("déjà associé à un autre téléphone"), b1.json);
  const b1bis = await connexion(c1, B);
  verifie("B est refusé même sans annoncer son type (préfixe mob-)",
    b1bis.statut === 409, b1bis);
  verifie("le compte est toujours lié à A", (await lie(c1)).deviceId === A);
  const ra = await rafraichir(jetons(a2).refreshToken);
  verifie("A n'est PAS déconnecté : il se rafraîchit", ra.statut === 200, ra);

  titre("④ « Dissocier ce téléphone », depuis A");
  const ligneA = await equipe(c1, A);
  const web0 = `banc-web0-${Date.now()}`;
  const w0 = await connexion(c1, web0, 0);
  verifie("un navigateur est ouvert à côté", w0.statut === 200, w0);
  const d4 = await appel("/api/account/dissocier", undefined, auth(ra));
  verifie("la dissociation répond 200", d4.statut === 200, d4);
  verifie("elle renvoie A à annoncer au temps réel",
    jetons(d4).telephones?.includes(A), jetons(d4));
  const l4 = await lie(c1);
  verifie("le compte est libre", l4.dissocier === true && l4.deviceId === null, l4);
  const ra1 = await rafraichir(jetons(ra).refreshToken);
  verifie("A est déconnecté (SESSION_REVOQUEE, pas « ouvert ailleurs »)",
    ra1.statut === 401 && ra1.code === "SESSION_REVOQUEE", ra1);
  verifie("A ne reçoit plus de notifications", (await pushDe(c1, A)) === 0);
  verifie("la ligne de A passe en « déconnecté »", (await ligneDe(ligneA)).destroy === 1);
  const w0r = await rafraichir(jetons(w0).refreshToken);
  verifie("le navigateur n'est PAS touché", w0r.statut === 200, w0r);
  const d4bis = await appel("/api/account/dissocier", undefined, auth(w0));
  verifie("répéter le geste sur un compte libre ne nuit pas",
    d4bis.statut === 200 && (await lie(c1)).dissocier === true, d4bis);
  const d4sans = await appel("/api/account/dissocier", undefined, {});
  verifie("sans session, la route refuse (401)", d4sans.statut === 401, d4sans);

  titre("⑤ B après dissociation");
  const b2 = await connexion(c1, B, 1);
  verifie("B se connecte", b2.statut === 200, b2);
  const l5 = await lie(c1);
  verifie("le compte est lié à B", l5.deviceId === B && !l5.dissocier, l5);
  const a3 = await connexion(c1, A, 1);
  verifie("A est refusé à son tour", a3.statut === 409, a3);
  const ra2 = await rafraichir(jetons(ra).refreshToken);
  verifie("l'ancienne session de A ne se rafraîchit plus", ra2.statut === 401, ra2);

  titre("⑥ Deux téléphones au même instant, compte libre");
  const c2 = await nouveauCompte();
  comptes.push(c2);
  const [x, y] = await Promise.all([connexion(c2, A, 1), connexion(c2, B, 1)]);
  const passes = [x, y].filter((r) => r.statut === 200).length;
  const refus = [x, y].filter((r) => r.statut === 409).length;
  verifie("un seul passe, l'autre est refusé", passes === 1 && refus === 1,
    [x.statut, y.statut]);
  const l6 = await lie(c2);
  const gagnant = x.statut === 200 ? A : B;
  verifie("le compte est lié au gagnant", l6.deviceId === gagnant, { l6, gagnant });
  const [p, q] = await Promise.all([connexion(c2, gagnant, 1), connexion(c2, gagnant, 1)]);
  verifie("double appui du téléphone lié : les deux passent",
    p.statut === 200 && q.statut === 200, [p.statut, q.statut]);
  verifie("et reçoivent deux jetons DIFFÉRENTS",
    jetons(p).refreshToken !== jetons(q).refreshToken);

  titre("⑦ Session d'un téléphone non lié, ouverte avant la règle");
  const c3 = await nouveauCompte();
  comptes.push(c3);
  const c3a = await connexion(c3, C, 1);
  verifie("C se connecte (compte libre)", c3a.statut === 200, c3a);
  // Le compte est lié ailleurs, comme les deux comptes à deux téléphones du
  // 28/09 : C garde une session vivante qu'aucune connexion n'a refusée.
  await prisma.user.update({ where: { id: c3.id }, data: { deviceId: A, dissocier: false } });
  const r7 = await rafraichir(jetons(c3a).refreshToken);
  verifie("C est coupé avec SESSION_EVINCEE (connu des APK installés)",
    r7.statut === 401 && r7.code === "SESSION_EVINCEE", r7);
  const r7bis = await rafraichir(jetons(c3a).refreshToken);
  verifie("le réessai reçoit le même verdict", r7bis.code === "SESSION_EVINCEE", r7bis);
  verifie("le compte reste lié à A", (await lie(c3)).deviceId === A);

  titre("⑧ Téléphone sans identifiant");
  const c4 = await nouveauCompte();
  comptes.push(c4);
  const s8 = await connexion(c4, undefined, 1);
  verifie("refusé (400 TELEPHONE_NON_IDENTIFIE)",
    s8.statut === 400 && s8.code === "TELEPHONE_NON_IDENTIFIE", s8);
  verifie("et rien n'a été lié", (await lie(c4)).dissocier === true);

  titre("⑨ Inscription");
  const c5 = await prisma.user.create({
    data: {
      publicNumber: `8${String(Date.now()).slice(-7)}`,
      pseudo: "Banc inscription",
    },
  });
  comptes.push(c5);
  const setup = jwt.sign({ sub: c5.id, scope: "setup" }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: "15m",
  });
  const s9 = await appel(
    "/api/auth/setup",
    { pseudo: "Banc inscription", password: MOT_DE_PASSE, deviceId: A },
    { authorization: `Bearer ${setup}` },
  );
  verifie("l'inscription réussit", s9.statut === 201, s9);
  verifie("le compte est lié au téléphone d'inscription", (await lie(c5)).deviceId === A);
  const s9b = await connexion(c5, B, 1);
  verifie("un autre téléphone est refusé ensuite", s9b.statut === 409, s9b);

  titre("⑩ Le web");
  const web = `banc-web-${Date.now()}`;
  const w1 = await connexion(c1, web, 0);
  verifie("un navigateur se connecte sur un compte lié", w1.statut === 200, w1);
  verifie("le téléphone lié n'a pas changé", (await lie(c1)).deviceId === B);
  const w2 = await rafraichir(jetons(w1).refreshToken);
  verifie("le navigateur se rafraîchit", w2.statut === 200, w2);

  titre("⑪ « Déconnecter » un téléphone NON lié, depuis le web");
  const d11 = await appel(`/api/appareils/${ligneA.appareilId}`, undefined, auth(w2), "DELETE");
  verifie("la déconnexion répond 200", d11.statut === 200, d11);
  verifie("elle ne dissocie pas", jetons(d11).dissocie !== true, jetons(d11));
  verifie("le compte reste lié à B", (await lie(c1)).deviceId === B);

  titre("⑫ « Déconnecter » le téléphone lié, depuis le web");
  const ligneB = await equipe(c1, B);
  const d12 = await appel(`/api/appareils/${ligneB.appareilId}`, undefined, auth(w2), "DELETE");
  verifie("la déconnexion répond 200 et dit « dissocié »",
    d12.statut === 200 && jetons(d12).dissocie === true, d12);
  const l12 = await lie(c1);
  verifie("le compte est libre", l12.dissocier === true && l12.deviceId === null, l12);
  const rb = await rafraichir(jetons(b2).refreshToken);
  verifie("B est déconnecté", rb.statut === 401 && rb.code === "SESSION_REVOQUEE", rb);
  verifie("B ne reçoit plus de notifications", (await pushDe(c1, B)) === 0);
  const w3 = await rafraichir(jetons(w2).refreshToken);
  verifie("le navigateur reste connecté", w3.statut === 200, w3);
  const a12 = await connexion(c1, A, 1);
  verifie("A peut de nouveau se connecter", a12.statut === 200, a12);
  verifie("et le compte est lié à A", (await lie(c1)).deviceId === A);
} finally {
  for (const c of comptes) {
    await prisma.user.delete({ where: { id: c.id } }).catch(() => undefined);
  }
  await prisma.$disconnect();
}

console.log(echecs === 0 ? "\n\x1b[32mTout passe.\x1b[0m" : `\n\x1b[31m${echecs} échec(s).\x1b[0m`);
process.exit(echecs === 0 ? 0 : 1);
