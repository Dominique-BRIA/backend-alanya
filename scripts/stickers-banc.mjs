// Banc d'essai — les stickers côté utilisateur (24/10/2026, « comme WhatsApp »).
//
//   ① fermés par la console : tout répond 404, un sticker en clair est refusé ;
//   ② ouverts : catalogue, panneau par défaut (tous les packs publiés),
//      retrait, ajout, ordre, favoris ;
//   ③ envoi en clair (HTTP et temps réel) : la charge est relue en base et
//      réécrite, un sticker inconnu ou d'un pack archivé est refusé, l'aperçu
//      de la conversation dit « 👋 Sticker » ;
//   ④ envoi chiffré : la ligne STICKER part sans contenu (le serveur ne voit pas
//      la charge) ;
//   ⑤ réglages remis comme avant.
//
// Prérequis : Next sur API_URL (défaut :3020), ws-server sur WS_URL (défaut
// :3010), base de DÉVELOPPEMENT avec les comptes `*@banc-gestion.test` et au
// moins deux packs publiés.
//
// Usage : node --env-file=.env scripts/stickers-banc.mjs
import { execFileSync } from "node:child_process";

const API = process.env.API_URL ?? "http://localhost:3020";
const WS = process.env.WS_URL ?? "ws://localhost:3010";
const PSQL = process.env.PSQL ?? "C:/Program Files/PostgreSQL/18/bin/psql.exe";
const MDP = process.env.BANC_MDP ?? "Banc-gestion-2026";
let ok = 0;
let ko = 0;
const verifier = (nom, c, d = "") => (c ? (ok++, console.log(`✓ ${nom}`)) : (ko++, console.log(`✗ ${nom} ${d}`)));
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

async function appel(methode, chemin, { jeton, corps } = {}) {
  const r = await fetch(`${API}/api${chemin}`, {
    method: methode,
    headers: { ...(corps !== undefined ? { "Content-Type": "application/json" } : {}), ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) },
    body: corps === undefined ? undefined : JSON.stringify(corps),
  });
  const t = await r.text();
  let d;
  try { d = JSON.parse(t); } catch { d = t; }
  return { statut: r.status, donnees: d };
}
const sql = (q) =>
  execFileSync(PSQL, [process.env.DATABASE_URL.replace(/\?.*$/, ""), "-At", "-c", q], { encoding: "utf8", env: { ...process.env, PGCLIENTENCODING: "UTF8" } })
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const connexion = async (email) => (await appel("POST", "/auth/login", { corps: { identifier: email, password: MDP } })).donnees.accessToken;

const admin = (await appel("POST", "/admin/auth/login", { corps: { email: "super@banc-gestion.test", password: MDP } })).donnees.accessToken;
const avant = (await appel("GET", "/admin/sticker-settings", { jeton: admin })).donnees;
const reglages = (enabled) => appel("PUT", "/admin/sticker-settings", { jeton: admin, corps: { enabled } });

const a = await connexion("simple@banc-gestion.test");
const b = await connexion("super2@banc-gestion.test");
const idA = sql(`select "alanyaID" from users where email = 'simple@banc-gestion.test'`)[0];
const idB = sql(`select "alanyaID" from users where email = 'super2@banc-gestion.test'`)[0];
// Un panneau neuf pour A : c'est le cadeau de bienvenue qu'on veut voir.
sql(`delete from sticker_installation where user_id = '${idA}'`);
sql(`delete from sticker_favori where user_id = '${idA}'`);

// Deux conversations A ↔ B : une en clair, une chiffrée.
const conv = (await appel("POST", "/conversations", { jeton: a, corps: { publicNumber: "99000004" } })).donnees;
const convId = conv.id ?? conv.conversation?.id;
sql(`update conversation set e2ee_actif = false where "conversID" = '${convId}'`);

const [pack1, pack2] = sql(`select id || '|' || code from sticker_pack where statut = 1 order by ordre, id limit 2`).map((l) => l.split("|"));
const [sid, asset, emoji] = sql(`select s.id || '|' || s.asset_id || '|' || s.emoji from sticker s join sticker_asset a on a.id = s.asset_id
                                  where s.pack_id = ${pack1[0]} and a.statut = 0 and not a.anime order by s.position limit 1`)[0].split("|");
const charge = (extra = {}) => JSON.stringify({ v: 1, pack: pack1[1], sid: Number(sid), asset: Number(asset), emoji: "❓", w: 1, h: 1, a: 1, ...extra });

// ① Fermés.
await reglages(false);
verifier("fermés : /me → 404", (await appel("GET", "/stickers/me", { jeton: a })).statut === 404);
verifier("fermés : catalogue → enabled false", (await appel("GET", "/stickers", { jeton: a })).donnees.enabled === false);
const fermeEnvoi = await appel("POST", `/conversations/${convId}/messages`, { jeton: a, corps: { type: "STICKER", content: charge() } });
verifier("fermés : sticker en clair → 400 STICKER_INVALID_PAYLOAD", fermeEnvoi.statut === 400 && (fermeEnvoi.donnees.error?.code ?? fermeEnvoi.donnees.code) === "STICKER_INVALID_PAYLOAD", JSON.stringify(fermeEnvoi.donnees));

// ② Ouverts.
await reglages(true);
const cat = (await appel("GET", "/stickers", { jeton: a })).donnees;
verifier("catalogue : packs publiés, avec assetId", cat.enabled === true && cat.packs.length >= 2 && Number.isInteger(cat.packs[0].stickers[0].assetId), JSON.stringify(cat).slice(0, 200));
const nbPublies = Number(sql(`select count(*) from sticker_pack where statut = 1`)[0]);
let moi = (await appel("GET", "/stickers/me", { jeton: a })).donnees;
verifier(`panneau par défaut : les ${nbPublies} packs publiés`, moi.packs?.length === nbPublies && Array.isArray(moi.favorites), JSON.stringify(moi).slice(0, 200));

verifier("retirer un pack → 204", (await appel("DELETE", `/stickers/me/packs/${pack1[0]}`, { jeton: a })).statut === 204);
moi = (await appel("GET", "/stickers/me", { jeton: a })).donnees;
verifier("il a quitté le panneau, et ne revient pas au rechargement", !moi.packs.some((p) => p.id === Number(pack1[0])) && moi.packs.length === nbPublies - 1);
verifier("le rajouter → 204", (await appel("PUT", `/stickers/me/packs/${pack1[0]}`, { jeton: a })).statut === 204);
verifier("le rajouter deux fois → 204 (idempotent)", (await appel("PUT", `/stickers/me/packs/${pack1[0]}`, { jeton: a })).statut === 204);
moi = (await appel("GET", "/stickers/me", { jeton: a })).donnees;
verifier("rajouté, il va en dernier", moi.packs.at(-1)?.id === Number(pack1[0]), JSON.stringify(moi.packs));
const ordre = [Number(pack1[0]), ...moi.packs.filter((p) => p.id !== Number(pack1[0])).map((p) => p.id)];
verifier("ordonner → 204", (await appel("PUT", "/stickers/me/packs/order", { jeton: a, corps: { ids: ordre } })).statut === 204);
moi = (await appel("GET", "/stickers/me", { jeton: a })).donnees;
verifier("l'ordre est tenu", JSON.stringify(moi.packs.map((p) => p.id)) === JSON.stringify(ordre), JSON.stringify(moi.packs));
verifier("ordre mal formé → 400", (await appel("PUT", "/stickers/me/packs/order", { jeton: a, corps: { ids: ["x"] } })).statut === 400);
verifier("pack inconnu → 404", (await appel("PUT", "/stickers/me/packs/999999", { jeton: a })).statut === 404);

verifier("favori → 204", (await appel("PUT", `/stickers/me/favorites/${sid}`, { jeton: a })).statut === 204);
moi = (await appel("GET", "/stickers/me", { jeton: a })).donnees;
verifier("il est dans les favoris", moi.favorites.includes(Number(sid)), JSON.stringify(moi.favorites));
verifier("favori inconnu → 404", (await appel("PUT", "/stickers/me/favorites/999999", { jeton: a })).statut === 404);
verifier("retirer le favori → 204", (await appel("DELETE", `/stickers/me/favorites/${sid}`, { jeton: a })).statut === 204);
moi = (await appel("GET", "/stickers/me", { jeton: a })).donnees;
verifier("il a quitté les favoris", !moi.favorites.includes(Number(sid)));

// ③ Envoi en clair, par HTTP.
const envoi = await appel("POST", `/conversations/${convId}/messages`, { jeton: a, corps: { type: "STICKER", content: charge() } });
const msg = envoi.donnees.message ?? envoi.donnees;
const lu = JSON.parse(msg.content ?? "{}");
verifier("sticker en clair → 201", envoi.statut === 201 || envoi.statut === 200, JSON.stringify(envoi.donnees).slice(0, 200));
verifier("charge RÉÉCRITE depuis la base (émoji, animé, dimensions)", lu.emoji === emoji && lu.a === 0 && lu.w === 512 && lu.sid === Number(sid) && lu.asset === Number(asset), msg.content);
const apercu = sql(`select "lastMessage" from conversation where "conversID" = '${convId}'`)[0];
verifier("l'aperçu de la conversation dit « Sticker »", apercu === `${emoji} Sticker` || apercu === "Sticker", apercu);
const inconnu = await appel("POST", `/conversations/${convId}/messages`, { jeton: a, corps: { type: "STICKER", content: charge({ sid: 999999 }) } });
verifier("sticker inconnu → 404 STICKER_NOT_FOUND", inconnu.statut === 404 && (inconnu.donnees.error?.code ?? inconnu.donnees.code) === "STICKER_NOT_FOUND", JSON.stringify(inconnu.donnees));
const illisible = await appel("POST", `/conversations/${convId}/messages`, { jeton: a, corps: { type: "STICKER", content: "salut" } });
verifier("charge illisible → refusée (4xx)", illisible.statut >= 400 && illisible.statut < 500, JSON.stringify(illisible.donnees));
sql(`update sticker_pack set statut = 2 where id = ${pack1[0]}`);
const archive = await appel("POST", `/conversations/${convId}/messages`, { jeton: a, corps: { type: "STICKER", content: charge() } });
verifier("pack archivé → 404 STICKER_PACK_UNAVAILABLE", archive.statut === 404 && (archive.donnees.error?.code ?? archive.donnees.code) === "STICKER_PACK_UNAVAILABLE", JSON.stringify(archive.donnees));
moi = (await appel("GET", "/stickers/me", { jeton: a })).donnees;
verifier("pack archivé : il sort du panneau", !moi.packs.some((p) => p.id === Number(pack1[0])));
sql(`update sticker_pack set statut = 1 where id = ${pack1[0]}`);

// … et par le temps réel.
const ws = new WebSocket(`${WS}?token=${encodeURIComponent(a)}`);
const trames = [];
ws.onmessage = (m) => trames.push(JSON.parse(m.data));
await new Promise((r, e) => { ws.onopen = r; ws.onerror = e; });
await attendre(500);
ws.send(JSON.stringify({ type: "send", convId, tempId: "banc-sticker-1", msgType: "STICKER", content: charge() }));
ws.send(JSON.stringify({ type: "send", convId, tempId: "banc-sticker-2", msgType: "STICKER", content: charge({ sid: 999999 }) }));
await attendre(2000);
const echo = trames.find((t) => t.tempId === "banc-sticker-1" && t.type !== "error");
const echoMsg = echo?.message ?? echo;
verifier("temps réel : sticker accepté et réécrit", !!echoMsg && JSON.parse(echoMsg.content ?? "{}").emoji === emoji, JSON.stringify(echo ?? trames.slice(-3)).slice(0, 300));
const refus = trames.find((t) => t.tempId === "banc-sticker-2");
verifier("temps réel : sticker inconnu → erreur STICKER_NOT_FOUND", refus?.type === "error" && refus.code === "STICKER_NOT_FOUND", JSON.stringify(refus));
ws.close();

// ④ Chiffré : la ligne part sans contenu.
sql(`update conversation set e2ee_actif = true where "conversID" = '${convId}'`);
const chiffre = await appel("POST", `/conversations/${convId}/messages`, { jeton: a, corps: { type: "STICKER", chiffre: true } });
const mc = chiffre.donnees.message ?? chiffre.donnees;
verifier("chiffré : ligne STICKER sans contenu → 201", (chiffre.statut === 201 || chiffre.statut === 200) && mc.type === "STICKER" && !mc.content, JSON.stringify(chiffre.donnees).slice(0, 200));
const clairRefuse = await appel("POST", `/conversations/${convId}/messages`, { jeton: a, corps: { type: "STICKER", content: charge() } });
verifier("chiffré : le clair est refusé", clairRefuse.statut >= 400, JSON.stringify(clairRefuse.donnees));
sql(`update conversation set e2ee_actif = false where "conversID" = '${convId}'`);

// ⑤ Comme avant.
await reglages(avant?.enabled === 1 || avant?.enabled === true);
console.log(`\n${ok} ✓, ${ko} ✗`);
process.exit(ko ? 1 : 0);
