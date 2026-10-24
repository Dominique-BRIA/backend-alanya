// Banc d'essai — diffusions riches : image légendée et statut, en fr/en/zh (24/10/2026).
//
// Prérequis : serveur sur API_URL (défaut http://localhost:3020), base de
// DÉVELOPPEMENT avec le compte officiel et le super-admin de banc. Le banc
// recrée lui-même les trois comptes `langue-{fr,zh,es}@banc-gestion.test`,
// inscrits en 2030 le temps du passage (c'est ce qui permet de les viser
// seuls, par la date d'inscription), puis remis en 2026.
//
// Usage : node --env-file=.env scripts/gestion-diffusions-riches-banc.mjs <image.png>
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import bcrypt from "bcryptjs";

const API = process.env.API_URL ?? "http://localhost:3020";
const PSQL = process.env.PSQL ?? "C:/Program Files/PostgreSQL/18/bin/psql.exe";
let ok = 0;
let ko = 0;
const verifier = (nom, c, d = "") => (c ? (ok++, console.log(`✓ ${nom}`)) : (ko++, console.log(`✗ ${nom} ${d}`)));
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

async function appel(methode, chemin, { jeton, corps, formulaire } = {}) {
  const r = await fetch(`${API}/api${chemin}`, {
    method: methode,
    headers: { ...(corps ? { "Content-Type": "application/json" } : {}), ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) },
    body: formulaire ?? (corps === undefined ? undefined : JSON.stringify(corps)),
  });
  const t = await r.text();
  let d;
  try { d = JSON.parse(t); } catch { d = t; }
  return { statut: r.status, donnees: d };
}
const sql = (q) =>
  execFileSync(PSQL, [process.env.DATABASE_URL.replace(/\?.*$/, ""), "-At", "-c", q], { encoding: "utf8", env: { ...process.env, PGCLIENTENCODING: "UTF8" } })
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

// Les comptes de langue, neufs à chaque passage et inscrits en 2030 le temps du
// banc (puis remis en 2026, pour ne pas fausser les autres bancs qui comptent
// par date d'inscription).
const h = bcrypt.hashSync("Banc-gestion-2026", 12);
sql(`delete from users where email like 'langue-%@banc-gestion.test'`);
for (const [l, n] of [["fr", "11"], ["zh", "12"], ["es", "13"]]) {
  sql(`insert into users ("alanyaID", email, password, "alanyaPhone", "emailVerified", nom, pseudo, type_compte, role_admin, langue, actif, exclus, "isDelete", created_at, "updatedAt")
       values (gen_random_uuid(), 'langue-${l}@banc-gestion.test', '${h}', '990000${n}', true, 'Langue ${l.toUpperCase()}', 'langue${l}', 0, 0, '${l}', 1, 0, false, '2030-01-01', now())`);
}
const j = (await appel("POST", "/admin/auth/login", { corps: { email: "super@banc-gestion.test", password: "Banc-gestion-2026" } })).donnees.accessToken;
const criteria = { v: 1, op: "and", conditions: [{ field: "created_at", op: "after", value: { absolute: "2029-12-31T00:00:00Z" } }] };
const est = await appel("POST", "/admin/broadcasts/estimate", { jeton: j, corps: { criteria } });
verifier("l'estimation vise les 3 comptes de langue", est.donnees.count === 3, JSON.stringify(est.donnees));

const f = new FormData();
f.append("file", new Blob([readFileSync(process.argv[2])], { type: "image/png" }), "diffusion.png");
const media = (await appel("POST", "/upload/media", { jeton: j, formulaire: f })).donnees.url;

const sansAnglais = await appel("POST", "/admin/broadcasts", {
  jeton: j,
  corps: { content: "Seulement en français", type: 0, criteria, clientId: `banc-${Date.now()}-a`, confirmedEstimate: 3 },
});
verifier("sans l'anglais → 400 TRANSLATION_MISSING", sansAnglais.statut === 400 && sansAnglais.donnees.code === "TRANSLATION_MISSING", JSON.stringify(sansAnglais.donnees));

// 1. Image légendée, trois langues.
const image = await appel("POST", "/admin/broadcasts", {
  jeton: j,
  corps: {
    content: "Nouveauté", contentEn: "What's new", translations: { zh: "新功能" },
    type: 1, mediaUrl: media, criteria, clientId: `banc-${Date.now()}-b`, confirmedEstimate: 3,
  },
});
verifier("diffusion image créée", image.statut === 200 || image.statut === 201, JSON.stringify(image.donnees).slice(0, 200));

// 2. Statut texte, trois langues, couleur.
const statut = await appel("POST", "/admin/broadcasts", {
  jeton: j,
  corps: {
    content: "Maintenance ce soir", contentEn: "Maintenance tonight", translations: { zh: "今晚维护" },
    type: 0, kind: 1, backgroundColor: "#c2410c", criteria, clientId: `banc-${Date.now()}-c`, confirmedEstimate: 3,
  },
});
verifier("diffusion en statut créée", statut.statut === 200 || statut.statut === 201, JSON.stringify(statut.donnees).slice(0, 200));

// 3. Boutons (24/10/2026) : les refus d'abord, puis une annonce texte à deux
//    boutons, un lien et un écran, en trois langues.
const lien = { action: "url", target: "https://alanyavox.com", labels: { fr: "Découvrir", en: "Discover", zh: "了解" } };
const ecran = { action: "route", target: "profile", labels: { fr: "Mon profil", en: "My profile", zh: "我的资料" } };
const annonce = (boutons, suffixe, extra = {}) =>
  appel("POST", "/admin/broadcasts", {
    jeton: j,
    corps: {
      content: "Annonce", contentEn: "Announcement", translations: { zh: "公告" },
      type: 0, criteria, clientId: `banc-${Date.now()}-${suffixe}`, confirmedEstimate: 3, buttons: boutons, ...extra,
    },
  });
for (const [nom, boutons, code, extra] of [
  ["un statut ne porte pas de bouton", [lien], "BUTTONS_NOT_ALLOWED", { kind: 1 }],
  ["quatre boutons", [lien, ecran, lien, ecran], "TOO_MANY_BUTTONS"],
  ["un lien javascript:", [{ ...lien, target: "javascript:alert(1)" }], "INVALID_BUTTON"],
  ["un écran inconnu", [{ ...ecran, target: "admin" }], "INVALID_BUTTON"],
  ["un libellé sans l'anglais", [{ ...lien, labels: { fr: "Découvrir" } }], "TRANSLATION_MISSING"],
]) {
  const r = await annonce(boutons, `refus-${code}-${Math.random()}`, extra);
  verifier(`boutons — ${nom} → 400 ${code}`, r.statut === 400 && r.donnees.code === code, JSON.stringify(r.donnees));
}
// Les messages de cette annonce se reconnaissent à leur heure : la ligne de
// commande de psql, sous Windows, ne passe pas les accents d'un filtre.
const depuisBoutons = sql("select now()")[0];
const avecBoutons = await annonce([lien, ecran], "d");
verifier("diffusion à boutons créée", avecBoutons.statut === 200 || avecBoutons.statut === 201, JSON.stringify(avecBoutons.donnees).slice(0, 200));

await attendre(10000);

for (const [langue, texte, l1, l2] of [["fr", "Annonce", "Découvrir", "Mon profil"], ["zh", "公告", "了解", "我的资料"], ["es", "Announcement", "Discover", "My profile"]]) {
  const fil = sql(`
    select replace(coalesce(m.content, ''), chr(10), ' / ') || '|' || coalesce(m.boutons::text, '')
      from message m join users u on u.email = 'langue-${langue}@banc-gestion.test'
     where m."conversationID" in (select "conversID" from conv_participants where "alanyaID" = u."alanyaID")
       and m.type = 'TEXT' and m."sendAt" >= '${depuisBoutons}'
     order by m."sendAt", m.boutons nulls first`);
  verifier(`${langue} : le texte arrive, puis ses boutons`, fil.length === 2 && fil[0] === `${texte}|`, JSON.stringify(fil));
  const boutons = fil[1] ? JSON.parse(fil[1].split("|").slice(1).join("|")) : [];
  verifier(
    `${langue} : boutons dans sa langue (lien puis écran)`,
    boutons.length === 2 &&
      boutons[0].label === l1 && boutons[0].action === "url" && boutons[0].target === "https://alanyavox.com" &&
      boutons[1].label === l2 && boutons[1].action === "route" && boutons[1].target === "profile",
    JSON.stringify(boutons),
  );
}

for (const [langue, legende, texteStatut] of [["fr", "Nouveauté", "Maintenance ce soir"], ["zh", "新功能", "今晚维护"], ["es", "What's new", "Maintenance tonight"]]) {
  const messages = sql(`
    select m.type || '|' || coalesce(m.content, '') || '|' || (select count(*) from media_files f where f."messageId" = m."msgID")
      from message m join users u on u.email = 'langue-${langue}@banc-gestion.test'
     where m."conversationID" in (select "conversID" from conv_participants where "alanyaID" = u."alanyaID")
       and m.type = 'IMAGE'`);
  verifier(`${langue} : image légendée dans sa langue`, messages.length === 1 && messages[0] === `IMAGE|${legende}|1`, JSON.stringify(messages));

  const statuts = sql(`
    select s.text || '|' || coalesce(s."backgroundColor", '') from statut s
      join gestion_statut_destinataire d on d.statut_id = s."ID"
      join users u on u."alanyaID" = d.user_id and u.email = 'langue-${langue}@banc-gestion.test'`);
  verifier(`${langue} : statut dans sa langue`, statuts.length === 1 && statuts[0] === `${texteStatut}|#C2410C`, JSON.stringify(statuts));
}

// Le fil du lecteur chinois montre le statut de diffusion.
const zh = await appel("POST", "/auth/login", { corps: { identifier: "langue-zh@banc-gestion.test", password: "Banc-gestion-2026" } });
const fil = await appel("GET", "/statuses", { jeton: zh.donnees.accessToken });
const off = (fil.donnees.others ?? []).find((g) => g.pseudo === "Alanya Work");
verifier("le fil du lecteur zh montre le statut diffusé", !!off?.statuses?.some((s) => s.text === "今晚维护"), JSON.stringify(off?.statuses ?? fil.donnees).slice(0, 200));

sql(`update users set created_at = '2026-01-01' where email like 'langue-%@banc-gestion.test'`);
console.log(`\n${ok} ✓, ${ko} ✗`);
process.exit(ko ? 1 : 0);
