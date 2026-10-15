/**
 * BANC — LA CONNEXION DU SUPERROOT À LA CONSOLE DE GESTION (15/10/2026).
 *
 * Rejoue les règles de `src/lib/gestion/session.ts`, qui reproduisent la
 * connexion superroot d'alanyaCenter :
 *   ① le compte maître de l'environnement entre, avec `username` ou `email` ;
 *   ② un `Root` au mot de passe EN CLAIR entre (alanyaCenter l'accepte), et le
 *     type 0 est en lecture seule, sauf pour changer son mot de passe ;
 *   ③ un `Root` désactivé est refusé APRÈS le mot de passe ;
 *   ④ les jetons de gestion et ceux de l'application mobile ne s'ouvrent pas
 *     mutuellement ;
 *   ⑤ changer le mot de passe fait tomber les sessions ouvertes ;
 *   ⑥ la route existante `/api/admin/limites-reunion` répond toujours ;
 *   ⑦ dix échecs de suite bloquent la connexion (429).
 *
 * Usage (serveur démarré avec SUPER_ROOT_USERNAME / SUPER_ROOT_PASSWORD) :
 *   SUPER_ROOT_USERNAME=superroot SUPER_ROOT_PASSWORD=superroot \
 *     node --env-file=.env scripts/gestion-connexion-banc.mjs
 *
 * ⚠️ BASE DE DÉVELOPPEMENT SEULEMENT : le banc crée puis supprime deux lignes
 * `Root` (`banc-lecture`, `banc-inactif`).
 */
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const API = process.env.API_URL ?? "http://localhost:3000";
const MAITRE = process.env.SUPER_ROOT_USERNAME;
const MAITRE_MDP = process.env.SUPER_ROOT_PASSWORD;
if (!MAITRE || !MAITRE_MDP) {
  console.error("SUPER_ROOT_USERNAME et SUPER_ROOT_PASSWORD requis (les mêmes que le serveur).");
  process.exit(2);
}
const prisma = new PrismaClient();

let echecs = 0;
function verifie(libelle, condition, detail) {
  console.log(`  ${condition ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${libelle}`);
  if (!condition) {
    echecs++;
    if (detail !== undefined) console.log(`      \x1b[31m${JSON.stringify(detail)}\x1b[0m`);
  }
}
const titre = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

async function appel(methode, chemin, { jeton, corps } = {}) {
  const r = await fetch(`${API}${chemin}`, {
    method: methode,
    headers: {
      "Content-Type": "application/json",
      ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}),
    },
    body: corps === undefined ? undefined : JSON.stringify(corps),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, json };
}
const connexion = (corps) => appel("POST", "/api/admin/auth/login", { corps });

await prisma.root.deleteMany({ where: { username: { in: ["banc-lecture", "banc-inactif"] } } });
const lecture = await prisma.root.create({ data: { username: "banc-lecture", password: "clair-2026", type: 0, actif: 1 } });
await prisma.root.create({
  data: { username: "banc-inactif", password: await bcrypt.hash("inactif-2026", 10), type: 1, actif: 0 },
});

try {
  titre("① Le compte maître");
  const m = await connexion({ username: MAITRE.toUpperCase(), password: MAITRE_MDP });
  verifie("connexion par username (casse ignorée) → 200", m.status === 200, m);
  verifie("deux jetons rendus", !!m.json?.accessToken && !!m.json?.refreshToken);
  verifie("user.typeCompte = 2 et isMaster", m.json?.user?.typeCompte === 2 && m.json?.user?.isMaster === true, m.json?.user);
  const parEmail = await connexion({ email: MAITRE, password: MAITRE_MDP });
  verifie("connexion par le champ email (console d'origine) → 200", parEmail.status === 200, parEmail);
  const faux = await connexion({ username: MAITRE, password: "pas-le-bon" });
  verifie("mauvais mot de passe → 401 INVALID_CREDENTIALS", faux.status === 401 && faux.json?.code === "INVALID_CREDENTIALS", faux);
  const inconnu = await connexion({ username: "personne-ici", password: "x" });
  verifie("identifiant inconnu → même 401", inconnu.status === 401 && inconnu.json?.code === "INVALID_CREDENTIALS", inconnu);

  const moi = await appel("GET", "/api/admin/me", { jeton: m.json.accessToken });
  verifie("GET /me → 200", moi.status === 200, moi);
  verifie("toutes les permissions (59)", moi.json?.permissions?.length === 59, moi.json?.permissions?.length);
  const sans = await appel("GET", "/api/admin/me");
  verifie("sans jeton → 401 TOKEN_REQUIRED", sans.status === 401 && sans.json?.code === "TOKEN_REQUIRED", sans);
  const mdpMaitre = await appel("PUT", "/api/admin/me/password", {
    jeton: m.json.accessToken,
    corps: { currentPassword: MAITRE_MDP, newPassword: "nouveau-mdp-2026" },
  });
  verifie("mot de passe du maître → 400 MASTER_PASSWORD_IN_ENV", mdpMaitre.status === 400 && mdpMaitre.json?.code === "MASTER_PASSWORD_IN_ENV", mdpMaitre);

  titre("④ Les jetons ne se mélangent pas");
  const renouv = await appel("GET", "/api/admin/me", { jeton: m.json.refreshToken });
  verifie("jeton de renouvellement présenté comme accès → 401", renouv.status === 401, renouv);
  const r1 = await appel("POST", "/api/admin/auth/refresh", { corps: { refreshToken: m.json.refreshToken } });
  verifie("POST /auth/refresh → 200 et nouveaux jetons", r1.status === 200 && !!r1.json?.accessToken, r1);
  const r2 = await appel("POST", "/api/admin/auth/refresh", { corps: { refreshToken: m.json.accessToken } });
  verifie("jeton d'accès présenté au renouvellement → 401", r2.status === 401, r2);
  const mobile = jwt.sign({ sub: "1", scope: "access" }, process.env.JWT_ACCESS_SECRET, { expiresIn: "5m" });
  const mob = await appel("GET", "/api/admin/me", { jeton: mobile });
  verifie("jeton MOBILE sur /api/admin/me → 401 TOKEN_INVALID", mob.status === 401 && mob.json?.code === "TOKEN_INVALID", mob);
  const inv = await appel("GET", "/api/me", { jeton: m.json.accessToken });
  verifie("jeton de GESTION sur /api/me (mobile) → 401", inv.status === 401, inv);
  const expire = jwt.sign({ sub: "master", scope: "gestion", v: "x" }, "n-importe", { expiresIn: -10 });
  const exp = await appel("GET", "/api/admin/me", { jeton: expire });
  verifie("jeton étranger expiré → 401 (pas de fuite de signature)", exp.status === 401, exp);

  titre("② Root en clair, type 0 : lecture seule");
  const l = await connexion({ username: "banc-lecture", password: "clair-2026" });
  verifie("mot de passe en clair accepté → 200", l.status === 200, l);
  verifie("lectureSeule = true", l.json?.user?.lectureSeule === true, l.json?.user);
  const putMe = await appel("PUT", "/api/admin/me", { jeton: l.json.accessToken, corps: { nom: "x" } });
  verifie("écriture → 403 READ_ONLY", putMe.status === 403 && putMe.json?.code === "READ_ONLY", putMe);
  const mauvais = await appel("PUT", "/api/admin/me/password", {
    jeton: l.json.accessToken,
    corps: { currentPassword: "faux", newPassword: "nouveau-2026" },
  });
  verifie("mot de passe actuel faux → 401 PASSWORD_INCORRECT", mauvais.status === 401 && mauvais.json?.code === "PASSWORD_INCORRECT", mauvais);

  titre("⑤ Changer le mot de passe fait tomber les sessions");
  const change = await appel("PUT", "/api/admin/me/password", {
    jeton: l.json.accessToken,
    corps: { currentPassword: "clair-2026", newPassword: "nouveau-2026" },
  });
  verifie("changement permis en lecture seule → 200", change.status === 200, change);
  const ligne = await prisma.root.findUnique({ where: { idRoot: lecture.idRoot } });
  verifie("stocké en bcrypt à 10 tours ($2a$10$ / $2b$10$)", /^\$2[ab]\$10\$/.test(ligne.password), ligne.password.slice(0, 7));
  const apres = await appel("GET", "/api/admin/me", { jeton: l.json.accessToken });
  verifie("ancien jeton d'accès → 401 SESSION_REJECTED", apres.status === 401 && apres.json?.code === "SESSION_REJECTED", apres);
  const apresR = await appel("POST", "/api/admin/auth/refresh", { corps: { refreshToken: l.json.refreshToken } });
  verifie("ancien jeton de renouvellement → 401", apresR.status === 401, apresR);
  const nouvelle = await connexion({ username: "banc-lecture", password: "nouveau-2026" });
  verifie("connexion avec le nouveau mot de passe → 200", nouvelle.status === 200, nouvelle);

  titre("③ Root désactivé");
  const ina = await connexion({ username: "banc-inactif", password: "inactif-2026" });
  verifie("bon mot de passe → 403 ACCOUNT_INACTIVE", ina.status === 403 && ina.json?.code === "ACCOUNT_INACTIVE", ina);
  const inaFaux = await connexion({ username: "banc-inactif", password: "faux" });
  verifie("mauvais mot de passe → 401 (l'état ne fuit pas)", inaFaux.status === 401, inaFaux);

  titre("⑥ La route existante");
  const lim = await appel("GET", "/api/admin/limites-reunion");
  verifie("/api/admin/limites-reunion répond (pas 404)", lim.status !== 404, lim.status);

  titre("⑦ Plafond de tentatives");
  let dernier;
  for (let i = 0; i < 11; i++) dernier = await connexion({ username: "banc-plafond", password: "faux" });
  verifie("11ᵉ échec → 429 RATE_LIMITED", dernier.status === 429 && dernier.json?.code === "RATE_LIMITED", dernier);
} finally {
  await prisma.root.deleteMany({ where: { username: { in: ["banc-lecture", "banc-inactif"] } } });
  await prisma.$disconnect();
}

console.log(echecs === 0 ? "\n\x1b[32mTout est vert.\x1b[0m" : `\n\x1b[31m${echecs} échec(s).\x1b[0m`);
process.exit(echecs === 0 ? 0 : 1);
