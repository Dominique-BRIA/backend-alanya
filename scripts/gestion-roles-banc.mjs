// Banc d'essai — connexion à la console et rôles d'administration (24/10/2026).
//
// Prérequis : un serveur lancé (API_URL, par défaut http://localhost:3020) sur
// une base de développement où existent les comptes de banc
// `*@banc-gestion.test` (mot de passe BANC_MDP) :
//   99000001 super (rôle 2), 99000002 admin (1), 99000003 simple (0),
//   99000004 super2 (2).
//
// Usage : node scripts/gestion-roles-banc.mjs
const API = process.env.API_URL ?? "http://localhost:3020";
const MDP = process.env.BANC_MDP ?? "Banc-gestion-2026";

let ok = 0;
let ko = 0;
function verifier(nom, condition, detail = "") {
  if (condition) {
    ok++;
    console.log(`✓ ${nom}`);
  } else {
    ko++;
    console.log(`✗ ${nom} ${detail}`);
  }
}

async function appel(methode, chemin, { jeton, corps } = {}) {
  const r = await fetch(`${API}/api/admin${chemin}`, {
    method: methode,
    headers: {
      "Content-Type": "application/json",
      ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}),
    },
    body: corps === undefined ? undefined : JSON.stringify(corps),
  });
  const texte = await r.text();
  let donnees = null;
  try {
    donnees = JSON.parse(texte);
  } catch {
    donnees = texte;
  }
  return { statut: r.status, donnees };
}

const connexion = (email, password = MDP) => appel("POST", "/auth/login", { corps: { email, password } });

// ── Connexion ────────────────────────────────────────────────────────────
const sup = await connexion("super@banc-gestion.test");
verifier("connexion par e-mail d'un super-admin", sup.statut === 200 && !!sup.donnees?.accessToken, JSON.stringify(sup.donnees));
verifier("le profil porte le rôle 2 dans typeCompte", sup.donnees?.user?.typeCompte === 2);
verifier("le super-admin a users.role", sup.donnees?.user?.permissions?.includes("users.role"));
verifier("aucune permission de facturation", !sup.donnees?.user?.permissions?.some((p) => p.startsWith("billing.")));
const jSup = sup.donnees?.accessToken;
const idSup = sup.donnees?.user?.alanyaID;

const parNumero = await connexion("99 00 00 01");
verifier("connexion par numéro Alanya, espaces compris", parNumero.statut === 200 && parNumero.donnees?.user?.alanyaID === idSup);

const parMajuscules = await connexion("SUPER@Banc-Gestion.TEST");
verifier("l'e-mail est insensible à la casse", parMajuscules.statut === 200);

const faux = await connexion("super@banc-gestion.test", "mauvais-mot-de-passe");
verifier("mot de passe faux → 401 INVALID_CREDENTIALS", faux.statut === 401 && faux.donnees?.code === "INVALID_CREDENTIALS");

const inconnu = await connexion("personne@banc-gestion.test");
verifier("compte inconnu → 401 INVALID_CREDENTIALS", inconnu.statut === 401 && inconnu.donnees?.code === "INVALID_CREDENTIALS");

const simple = await connexion("99000003");
verifier("simple utilisateur → 403 INSUFFICIENT_ROLE", simple.statut === 403 && simple.donnees?.code === "INSUFFICIENT_ROLE");

const superroot = await appel("POST", "/auth/login", { corps: { username: "superroot", password: "superroot" } });
verifier("le superroot n'entre plus", superroot.statut === 401);

// ── Permissions d'un admin ───────────────────────────────────────────────
const adm = await connexion("admin@banc-gestion.test");
const jAdm = adm.donnees?.accessToken;
verifier("connexion d'un admin", adm.statut === 200 && adm.donnees?.user?.typeCompte === 1);
verifier("l'admin n'a pas users.ban", !adm.donnees?.user?.permissions?.includes("users.ban"));
verifier("l'admin a users.read", adm.donnees?.user?.permissions?.includes("users.read"));
const meAdm = await appel("GET", "/me", { jeton: jAdm });
verifier("GET /me d'un admin", meAdm.statut === 200 && meAdm.donnees?.email === "admin@banc-gestion.test");

// ── Liste et filtres ─────────────────────────────────────────────────────
const admins = await appel("GET", "/users?status=admin&search=banc&limit=50", { jeton: jSup });
const numeros = (admins.donnees?.items ?? []).map((u) => u.alanyaPhone).sort();
verifier(
  "status=admin rend les trois administrateurs de banc",
  JSON.stringify(numeros) === JSON.stringify(["99000001", "99000002", "99000004"]),
  JSON.stringify(numeros),
);
const supers = await appel("GET", "/users?type_compte=2&search=banc&limit=50", { jeton: jSup });
verifier("type_compte=2 filtre les super-admins", (supers.donnees?.items ?? []).every((u) => u.typeCompte === 2) && supers.donnees?.items?.length === 2);

const idOf = async (numero) => (await appel("GET", `/users?search=${numero}`, { jeton: jSup })).donnees?.items?.[0]?.alanyaID;
const idAdm = await idOf("99000002");
const idSimple = await idOf("99000003");
const idSup2 = await idOf("99000004");

// ── Rôle ─────────────────────────────────────────────────────────────────
const refusAdmin = await appel("PUT", `/users/${idSimple}/role`, { jeton: jAdm, corps: { type_compte: 1 } });
verifier(
  "un admin ne peut pas changer un rôle → 403 Permission requise",
  refusAdmin.statut === 403 && refusAdmin.donnees?.code === "INSUFFICIENT_ROLE" && refusAdmin.donnees?.permission === "users.role",
  JSON.stringify(refusAdmin.donnees),
);
const promu = await appel("PUT", `/users/${idSimple}/role`, { jeton: jSup, corps: { type_compte: 1 } });
verifier("le super-admin promeut un utilisateur admin", promu.statut === 200 && promu.donnees?.type_compte === 1);
verifier("le compte promu se connecte", (await connexion("99000003")).statut === 200);
const retro = await appel("PUT", `/users/${idSimple}/role`, { jeton: jSup, corps: { type_compte: 0 } });
verifier("rétrogradé à utilisateur", retro.statut === 200);
verifier("rétrogradé : la connexion est refusée", (await connexion("99000003")).statut === 403);

const moiMeme = await appel("PUT", `/users/${idSup}/role`, { jeton: jSup, corps: { type_compte: 1 } });
verifier("se rétrograder soi-même → 400 CANNOT_TARGET_SELF", moiMeme.statut === 400 && moiMeme.donnees?.code === "CANNOT_TARGET_SELF");
const autreSuper = await appel("PUT", `/users/${idSup2}/role`, { jeton: jSup, corps: { type_compte: 0 } });
verifier("rétrograder un super-admin → 403 CANNOT_TARGET_SUPERADMIN", autreSuper.statut === 403 && autreSuper.donnees?.code === "CANNOT_TARGET_SUPERADMIN");
const invalide = await appel("PUT", `/users/${idSimple}/role`, { jeton: jSup, corps: { type_compte: 7 } });
verifier("rôle hors 0/1/2 → 400 INVALID_ACCOUNT_TYPE", invalide.statut === 400 && invalide.donnees?.code === "INVALID_ACCOUNT_TYPE");

// ── Bannissement ─────────────────────────────────────────────────────────
const banSoi = await appel("POST", `/users/${idSup}/ban`, { jeton: jSup, corps: { reason: "banc" } });
verifier("se bannir soi-même → 400 CANNOT_TARGET_SELF", banSoi.statut === 400 && banSoi.donnees?.code === "CANNOT_TARGET_SELF");
const banSuper = await appel("POST", `/users/${idSup2}/ban`, { jeton: jSup, corps: { reason: "banc" } });
verifier("bannir un super-admin → 403 CANNOT_TARGET_SUPERADMIN", banSuper.statut === 403 && banSuper.donnees?.code === "CANNOT_TARGET_SUPERADMIN");

// ── Sessions qui tombent ─────────────────────────────────────────────────
const avant = await appel("GET", "/me", { jeton: jAdm });
await appel("PUT", `/users/${idAdm}/role`, { jeton: jSup, corps: { type_compte: 0 } });
const apres = await appel("GET", "/me", { jeton: jAdm });
verifier("retirer le rôle fait tomber la session ouverte", avant.statut === 200 && apres.statut === 401, `${avant.statut} → ${apres.statut}`);
await appel("PUT", `/users/${idAdm}/role`, { jeton: jSup, corps: { type_compte: 1 } });

// ── Profil ───────────────────────────────────────────────────────────────
const renomme = await appel("PUT", "/me", { jeton: jSup, corps: { nom: "Super Banc Renommé" } });
verifier("PUT /me change le nom", renomme.statut === 200 && renomme.donnees?.nom === "Super Banc Renommé");
const vide = await appel("PUT", "/me", { jeton: jSup, corps: { nom: "  " } });
verifier("PUT /me refuse un nom vide", vide.statut === 400 && vide.donnees?.code === "FIELD_EMPTY");
await appel("PUT", "/me", { jeton: jSup, corps: { nom: "Super Banc" } });

// ── Journal d'audit ──────────────────────────────────────────────────────
const audit = await appel("GET", "/audit?limit=5", { jeton: jSup });
const derniere = (Array.isArray(audit.donnees) ? audit.donnees : [])[0];
verifier("l'audit nomme l'administrateur", audit.statut === 200 && JSON.stringify(derniere ?? {}).includes("Super Banc"), JSON.stringify(derniere ?? audit.donnees).slice(0, 200));

console.log(`\n${ok} ✓, ${ko} ✗`);
process.exit(ko ? 1 : 0);
