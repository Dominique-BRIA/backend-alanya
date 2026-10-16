/**
 * BANC — TOUTE LA CONSOLE DE GESTION (16/10/2026).
 *
 * Chaque domaine de `/api/admin/*` et les routes d'application qu'il
 * appelle : comptes, groupes, médias, réunions, statistiques, audit, purges,
 * santé, réglages, villes, numéros réservés, IA, bienvenue, signalements,
 * vérification, stickers, trajets. Pour chacun : la forme attendue par la
 * console, et les règles qui comptent (refus, unicité, effets en base).
 *
 * Usage (Next sur :3020 avec SUPER_ROOT_*, ws-server sur :3010) :
 *   SUPER_ROOT_USERNAME=superroot SUPER_ROOT_PASSWORD=superroot \
 *   API_URL=http://localhost:3020 node --env-file=.env scripts/gestion-console-banc.mjs
 *
 * ⚠️ BASE DE DÉVELOPPEMENT SEULEMENT. Tout ce que le banc crée est effacé à
 * la fin (sauf le compte officiel et les lignes du journal d'audit).
 */
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

const API = process.env.API_URL ?? "http://localhost:3000";
const prisma = new PrismaClient();

let echecs = 0;
let total = 0;
function verifie(libelle, condition, detail) {
  total++;
  console.log(`  ${condition ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${libelle}`);
  if (!condition) {
    echecs++;
    if (detail !== undefined) console.log(`      \x1b[31m${JSON.stringify(detail).slice(0, 600)}\x1b[0m`);
  }
}
const titre = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

let ADMIN = null;
async function appel(methode, chemin, { jeton = ADMIN, corps, brut } = {}) {
  const r = await fetch(`${API}${chemin}`, {
    method: methode,
    headers: {
      ...(brut ? {} : { "Content-Type": "application/json" }),
      ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}),
    },
    body: brut ?? (corps === undefined ? undefined : JSON.stringify(corps)),
  });
  const type = r.headers.get("content-type") ?? "";
  let json = null;
  let texte = null;
  if (type.includes("json")) json = await r.json().catch(() => null);
  else texte = await r.arrayBuffer().then((b) => Buffer.from(b)).catch(() => null);
  return { status: r.status, json, texte, type };
}
const jetonMobile = (id) => jwt.sign({ sub: id, scope: "access" }, process.env.JWT_ACCESS_SECRET, { expiresIn: "15m" });
const numero = () => String(Math.floor(10_000_000 + Math.random() * 89_999_999));
// Deux PNG 1×1 de couleurs différentes.
const PNG_ROUGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
const PNG_BLEU = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==", "base64");

const comptes = [];
const nettoyage = { groupes: [], reunions: [], numeros: [], packs: [], assets: [], diffusions: [] };

try {
  ADMIN = (
    await appel("POST", "/api/admin/auth/login", {
      jeton: null,
      corps: { username: process.env.SUPER_ROOT_USERNAME, password: process.env.SUPER_ROOT_PASSWORD },
    })
  ).json?.accessToken;
  if (!ADMIN) throw new Error("connexion superroot impossible");
  let off = (await appel("GET", "/api/admin/official-account")).json;
  if (!off) off = (await appel("POST", "/api/admin/official-account")).json;
  const pays = await prisma.pays.findFirst({ orderBy: { idPays: "asc" } });
  const nouveau = async (nom, extra = {}) => {
    const u = await prisma.user.create({
      data: { publicNumber: numero(), nom, pseudo: nom.toLowerCase().replace(/\s/g, ""), idPays: pays.idPays, typeCompte: 0, passwordHash: "banc", ...extra },
    });
    comptes.push(u.id);
    return u;
  };
  const a = await nouveau("Banc Console A");
  const b = await nouveau("Banc Console B");

  /* ─────────────── Comptes ─────────────── */
  titre("Comptes");
  const liste = await appel("GET", `/api/admin/users?search=${encodeURIComponent("Banc Console")}&limit=10`);
  verifie("liste filtrée : les 2 comptes du banc", liste.json?.total === 2 && liste.json.items.every((u) => u.nom.startsWith("Banc Console")), liste.json);
  verifie("forme User (alanyaID, alanyaPhone, paysLibelle)", liste.json?.items?.[0]?.alanyaID && "alanyaPhone" in liste.json.items[0] && "paysLibelle" in liste.json.items[0]);
  const fiche = await appel("GET", `/api/admin/users/${a.id}`);
  verifie("fiche → 200, jeton FCM jamais en clair", fiche.status === 200 && (fiche.json.fcmToken === "" || fiche.json.fcmToken === "•••"), fiche.json);
  verifie("activité → compteurs", typeof (await appel("GET", `/api/admin/users/${a.id}/activity`)).json?.messagesSent === "number");
  verifie("connexions → tableau", Array.isArray((await appel("GET", `/api/admin/users/${a.id}/logins`)).json));
  verifie("id invalide → 404", (await appel("GET", "/api/admin/users/pas-un-uuid")).status === 404);

  const libre = numero();
  const verif = await appel("GET", `/api/admin/alanya-phones/check-assignable?phone=${libre}`);
  verifie("numéro libre : assignable", verif.json?.assignable === true && verif.json?.tier === 8, verif.json);
  const pris = await appel("GET", `/api/admin/alanya-phones/check-assignable?phone=${b.publicNumber}`);
  verifie("numéro porté : refusé (is_taken)", pris.json?.assignable === false && pris.json?.is_taken === true, pris.json);
  const change = await appel("PUT", `/api/admin/users/${a.id}/phone`, { corps: { alanyaPhone: libre } });
  verifie("changement de numéro → 200", change.status === 200, change.json);
  verifie("numéro en base", (await prisma.user.findUnique({ where: { id: a.id } })).publicNumber === libre);
  const hist = await appel("GET", `/api/admin/users/${a.id}/phone-history`);
  verifie("historique : ancien → nouveau", hist.json?.history?.[0]?.oldPhone === a.publicNumber && hist.json.history[0].newPhone === libre, hist.json);
  const vole = await appel("PUT", `/api/admin/users/${a.id}/phone`, { corps: { alanyaPhone: b.publicNumber } });
  verifie("numéro d'un autre → 409", vole.status === 409, vole.json);

  await prisma.refreshToken.create({ data: { userId: b.id, tokenHash: `banc-${Date.now()}`, expiresAt: new Date(Date.now() + 86_400_000) } });
  const ban = await appel("POST", `/api/admin/users/${b.id}/ban`, { corps: { reason: "banc" } });
  const bLigne = await prisma.user.findUnique({ where: { id: b.id } });
  verifie("bannir → exclu, motif gardé", ban.status === 200 && bLigne.exclus === 1 && bLigne.excludeReason === "banc", ban.json);
  verifie("bannir → sessions coupées", (await prisma.refreshToken.count({ where: { userId: b.id, revoked: false } })) === 0);
  verifie("filtre « bannis » le trouve", (await appel("GET", `/api/admin/users?status=banned&search=${encodeURIComponent("Banc Console B")}`)).json?.total === 1);
  await appel("DELETE", `/api/admin/users/${b.id}/ban`);
  verifie("réhabiliter → exclus = 0", (await prisma.user.findUnique({ where: { id: b.id } })).exclus === 0);
  verifie("le compte officiel ne se bannit pas", (await appel("POST", `/api/admin/users/${off.alanyaID}/ban`, { corps: {} })).status === 400);

  const csv = await appel("GET", `/api/admin/users/export?search=${encodeURIComponent("Banc Console")}`);
  verifie("export CSV : 2 lignes + en-tête", csv.type.includes("text/csv") && csv.texte.toString("utf8").trim().split("\r\n").length === 3, csv.status);

  const agent = await appel("POST", "/api/admin/users", { corps: { nom: "X", pseudo: "x", password: "motdepasse", type_compte: 2 } });
  verifie("créer un agent ici → 400 (c'est alanyaCenter)", agent.status === 400 && agent.json?.code === "TYPE_NOT_ALLOWED", agent.json);

  /* ─────────────── Bienvenue (avant la création, qui doit la recevoir) ─────────────── */
  titre("Bienvenue");
  await prisma.gestionBienvenue.deleteMany({});
  const vide = await appel("GET", "/api/admin/welcome");
  verifie("état : ni publiée ni brouillon", vide.json?.active === null && vide.json?.draft === null, vide.json);
  const image = await appel("PUT", "/api/admin/welcome/draft", { corps: { blocks: [{ blockType: "image", contentFr: "x" }] } });
  verifie("bloc image → 400", image.status === 400, image.json);
  const brouillon = await appel("PUT", "/api/admin/welcome/draft", {
    corps: { blocks: [{ sortOrder: 0, blockType: "text", translations: { fr: "Bienvenue sur Alanya Work !" } }, { sortOrder: 1, blockType: "text", contentFr: "Deuxième bloc" }] },
  });
  verifie("brouillon : 2 blocs, version 1", brouillon.json?.isDraft === true && brouillon.json.blocks.length === 2 && brouillon.json.version === 1, brouillon.json);
  const pub = await appel("POST", "/api/admin/welcome/publish");
  verifie("publier → version active", pub.json?.isActive === true, pub.json);
  verifie("republier sans brouillon → 409", (await appel("POST", "/api/admin/welcome/publish")).status === 409);

  const cree = await appel("POST", "/api/admin/users", {
    corps: { nom: "Banc Console C", pseudo: "bancc", password: "motdepasse-2026", idPays: pays.idPays },
  });
  verifie("créer un compte → 201, numéro de 8 chiffres", cree.status === 201 && /^\d{8}$/.test(cree.json?.alanyaPhone ?? ""), cree.json);
  if (cree.json?.alanyaID) comptes.push(cree.json.alanyaID);
  await pause(1500);
  const recus = await prisma.message.count({ where: { senderId: off.alanyaID, conv: { participants: { some: { userId: cree.json.alanyaID } } } } });
  verifie("le nouveau compte a reçu la bienvenue (2 messages)", recus === 2, recus);

  const attente = (await appel("GET", "/api/admin/welcome")).json?.pendingBackfill;
  const rattrapage = await appel("POST", "/api/admin/welcome/backfill");
  verifie("rattrapage lancé", rattrapage.json?.queued === true && rattrapage.json.pending === attente, rattrapage.json);
  // Le rattrapage sert du plus ancien au plus récent : A, créé par le banc, passe en dernier.
  const recusDe = (id) => prisma.message.count({ where: { senderId: off.alanyaID, conv: { participants: { some: { userId: id } } } } });
  for (let i = 0; i < 120 && (await recusDe(a.id)) < 2; i++) await pause(1000);
  const recusA = await recusDe(a.id);
  verifie("A, compte existant, l'a reçue par le rattrapage", recusA === 2, recusA);
  await appel("POST", "/api/admin/welcome/backfill");
  await pause(3000);
  const recusA2 = await prisma.message.count({ where: { senderId: off.alanyaID, conv: { participants: { some: { userId: a.id } } } } });
  verifie("un second rattrapage ne la renvoie pas", recusA2 === 2, recusA2);
  verifie("statut de bienvenue : désactivé", (await appel("GET", "/api/admin/welcome/status")).json?.enabled === false);

  /* ─────────────── Groupes, médias, réunions ─────────────── */
  titre("Groupes, médias, réunions");
  const groupe = await prisma.conversation.create({
    data: { isGroup: true, name: "Banc groupe", participants: { create: [{ userId: a.id, role: "ADMIN" }, { userId: b.id }] } },
  });
  nettoyage.groupes.push(groupe.id);
  const msg = await prisma.message.create({ data: { convId: groupe.id, senderId: a.id, type: "IMAGE", content: null } });
  const media = await prisma.mediaFile.create({
    data: { ownerId: a.id, messageId: msg.id, filename: "banc.png", mimeType: "image/png", sizeBytes: 10, url: "banc/inexistant.png" },
  });
  verifie("groupes : le groupe du banc y est", (await appel("GET", "/api/admin/groups?search=Banc%20groupe")).json?.some((g) => g.conversID === groupe.id));
  const dg = await appel("GET", `/api/admin/groups/${groupe.id}`);
  verifie("détail : 2 membres, 1 message", dg.json?.memberCount === 2 && dg.json?.messageCount === 1, dg.json);
  const medias = await appel("GET", "/api/admin/media?limit=200");
  verifie("médias : le média du banc y est", medias.json?.some((m) => m.id === media.id && m.conversationName === "Banc groupe"), medias.status);
  verifie("suppression d'un média → 200", (await appel("DELETE", `/api/admin/media/${media.id}`)).status === 200);
  verifie("le message sans texte devient supprimé", (await prisma.message.findUnique({ where: { id: msg.id } })).deletedAt !== null);
  verifie("suppression du groupe → 200", (await appel("DELETE", `/api/admin/groups/${groupe.id}`)).status === 200);
  verifie("le groupe n'existe plus", (await prisma.conversation.findUnique({ where: { id: groupe.id } })) === null);

  const reunion = await prisma.meeting.create({
    data: { idOrganiser: a.id, start_time: new Date(), duree: 30, objet: "Banc réunion", room: `banc-${Date.now()}`, isEnd: 0, type_media: 0 },
  });
  nettoyage.reunions.push(reunion.idMeeting);
  verifie("réunions : la réunion du banc y est", (await appel("GET", "/api/admin/meetings")).json?.some((m) => m.idMeeting === reunion.idMeeting));
  verifie("terminer → 200", (await appel("POST", `/api/admin/meetings/${reunion.idMeeting}/end`)).status === 200);
  verifie("terminée en base", (await prisma.meeting.findUnique({ where: { idMeeting: reunion.idMeeting } })).isEnd === 1);
  verifie("terminer à nouveau → 409", (await appel("POST", `/api/admin/meetings/${reunion.idMeeting}/end`)).status === 409);
  verifie("supprimer → 200", (await appel("DELETE", `/api/admin/meetings/${reunion.idMeeting}`)).status === 200);

  /* ─────────────── Statistiques ─────────────── */
  titre("Statistiques");
  const stats = await appel("GET", "/api/admin/stats");
  verifie("tableau de bord : compteurs et 31 jours", stats.json?.counters?.totalUsers > 0 && stats.json.registrations.length >= 30, stats.json?.counters);
  const ana = await appel("GET", "/api/admin/analytics");
  verifie("analyses : toutes les sections", ["messagesByType", "calls", "stories", "meetings", "users", "devices", "conversations", "heatmap", "comparison"].every((k) => k in (ana.json ?? {})), Object.keys(ana.json ?? {}));
  verifie("export des analyses : CSV", (await appel("GET", "/api/admin/analytics/export")).type.includes("text/csv"));
  verifie("fil d'activité : tableau", Array.isArray((await appel("GET", "/api/admin/activity")).json));
  verifie("période invalide → 400", (await appel("GET", "/api/admin/stats?from=2026-10-10&to=2026-10-01")).status === 400);

  /* ─────────────── Audit ─────────────── */
  titre("Journal d'audit");
  const journal = await appel("GET", `/api/admin/audit?action=users.ban&targetId=${b.id}&limit=5`);
  verifie("le bannissement est au journal, avec son motif", journal.json?.[0]?.action === "users.ban" && journal.json[0].reason === "banc" && journal.json[0].targetId === b.id, journal.json?.[0]);
  verifie("vocabulaire des actions", (await appel("GET", "/api/admin/audit/actions")).json?.some((x) => x.action === "users.phone"));

  /* ─────────────── Purges, santé, réglages, villes ─────────────── */
  titre("Purges, santé, réglages, villes");
  const purges = await appel("GET", "/api/admin/purges");
  verifie("5 purges, avec volumes et réglages", purges.json?.purges?.length === 5 && purges.json.purges.every((p) => "knobs" in p && "runs" in p), purges.json?.purges?.map((p) => p.name));
  verifie("réglage hors bornes → 400", (await appel("PUT", "/api/admin/purges/journal-audit", { corps: { overrides: { jours: 5 } } })).status === 400);
  const regle = await appel("PUT", "/api/admin/purges/journal-audit", { corps: { enabled: false, overrides: { jours: 400 } } });
  verifie("réglage valide → appliqué", regle.json?.options?.jours === 400, regle.json);
  await appel("PUT", "/api/admin/purges/journal-audit", { corps: { overrides: { jours: null } } });
  const lancee = await appel("POST", "/api/admin/purges/statuts/run");
  verifie("lancer une purge → passage enregistré", lancee.json?.ok === true && lancee.json.runs?.[0]?.triggerSource === "manual", lancee.json);
  verifie("purge inconnue → 404", (await appel("POST", "/api/admin/purges/nimporte/run")).status === 404);
  const sante = await appel("GET", "/api/admin/health");
  verifie("santé : tâches, purges, connexions", sante.json?.jobs && Array.isArray(sante.json.purges) && sante.json.mysql?.mesurable === true, sante.json);
  verifie("réglages : lecture", (await appel("GET", "/api/admin/settings")).json?.appName === "Alanya Work");
  verifie("réglages : écriture refusée", (await appel("PUT", "/api/admin/settings", { corps: { maintenance: true } })).status === 400);
  verifie("sécurité : liaison au téléphone active", (await appel("GET", "/api/admin/security-settings")).json?.deviceBindingEnabled === true);
  verifie("villes : { items }", Array.isArray((await appel("GET", `/api/admin/villes?idPays=${pays.idPays}`)).json?.items));

  /* ─────────────── Numéros réservés ─────────────── */
  titre("Numéros réservés");
  const reserve = numero();
  nettoyage.numeros.push(reserve);
  verifie("réserver → 201", (await appel("POST", "/api/admin/reserved-alanya-phones", { corps: { phone: reserve, label: "Banc" } })).status === 201);
  verifie("deux fois → 409", (await appel("POST", "/api/admin/reserved-alanya-phones", { corps: { phone: reserve, label: "Banc" } })).status === 409);
  verifie("liste : présent, libre", (await appel("GET", `/api/admin/reserved-alanya-phones?q=${reserve}`)).json?.items?.[0]?.is_used === false);
  verifie("vérification : in_reserved_table", (await appel("GET", `/api/admin/alanya-phones/check-assignable?phone=${reserve}`)).json?.in_reserved_table === true);
  verifie("libérer → 200", (await appel("DELETE", `/api/admin/reserved-alanya-phones/${reserve}`)).status === 200);
  verifie("IA : état", typeof (await appel("GET", "/api/admin/ai/status")).json?.enabled === "boolean");

  /* ─────────────── Signalements ─────────────── */
  titre("Signalements");
  const direct = await prisma.conversation.create({ data: { isGroup: false, participants: { create: [{ userId: a.id }, { userId: b.id }] } } });
  nettoyage.groupes.push(direct.id);
  const insulte = await prisma.message.create({ data: { convId: direct.id, senderId: b.id, type: "TEXT", content: "message signalé" } });
  const sig = await appel("POST", "/api/signalements", { jeton: jetonMobile(a.id), corps: { cible: "message", messageId: insulte.id, motif: "harcelement", note: "banc" } });
  verifie("l'application signale → 201", sig.status === 201, sig.json);
  verifie("deux fois → 409", (await appel("POST", "/api/signalements", { jeton: jetonMobile(a.id), corps: { cible: "message", messageId: insulte.id, motif: "spam" } })).status === 409);
  verifie("son propre message → 400", (await appel("POST", "/api/signalements", { jeton: jetonMobile(b.id), corps: { cible: "message", messageId: insulte.id, motif: "spam" } })).status === 400);
  const file = await appel("GET", "/api/admin/reports?state=open");
  const r = file.json?.items?.find((x) => x.id === sig.json?.id);
  verifie("file : ouvert, extrait copié, auteur nommé", r?.msgContent === "message signalé" && r?.reporterNom === "Banc Console A" && file.json.open >= 1, r);
  await appel("POST", `/api/admin/reports/${sig.json.id}/actions`, { corps: { action: "reviewing" } });
  const clos = await appel("POST", `/api/admin/reports/${sig.json.id}/actions`, { corps: { action: "actioned", note: "averti" } });
  verifie("décisions → actioned", clos.json?.state === "actioned", clos.json);
  verifie("historique : 2 décisions", (await appel("GET", `/api/admin/reports/${sig.json.id}/actions`)).json?.length === 2);
  verifie("dossier clos → 409", (await appel("POST", `/api/admin/reports/${sig.json.id}/actions`, { corps: { action: "dismissed" } })).status === 409);

  /* ─────────────── Vérification ─────────────── */
  titre("Vérification des comptes");
  const form = new FormData();
  form.append("file", new Blob([PNG_ROUGE], { type: "image/png" }), "piece.png");
  const piece = await appel("POST", "/api/media", { jeton: jetonMobile(a.id), brut: form });
  const mediaId = piece.json?.id;
  verifie("pièce téléversée par le compte", !!mediaId, piece.json);
  const dem = await appel("POST", "/api/verification", { jeton: jetonMobile(a.id), corps: { nom: "Banc Console A", documents: [{ type: 1, mediaId }] } });
  verifie("demande → 201, statut 1", dem.status === 201 && dem.json?.statut === 1, dem.json);
  verifie("seconde demande pendant l'examen → 409", (await appel("POST", "/api/verification", { jeton: jetonMobile(a.id), corps: { nom: "Autre nom", documents: [{ type: 1, mediaId }] } })).status === 409);
  verifie("pièce d'un autre → 403", (await appel("POST", "/api/verification", { jeton: jetonMobile(b.id), corps: { nom: "Autre nom", documents: [{ type: 1, mediaId }] } })).status === 403);
  const vfile = await appel("GET", "/api/admin/verifications?queue=pending");
  const v = vfile.json?.requests?.find((x) => x.alanyaId === a.id);
  verifie("file « à examiner » : la demande", v?.claimedName === "Banc Console A" && v.documents === 1, vfile.json);
  verifie("compteurs : pending ≥ 1", (await appel("GET", "/api/admin/verifications/count")).json?.pending >= 1);
  const det = await appel("GET", `/api/admin/verifications/${v.id}`);
  const doc = await appel("GET", `/api/admin/verifications/documents/${det.json?.documents?.[0]?.id}`);
  verifie("la pièce s'ouvre, octet pour octet", doc.status === 200 && Buffer.compare(doc.texte, PNG_ROUGE) === 0, doc.status);
  verifie("refus sans motif → 400", (await appel("POST", `/api/admin/verifications/${v.id}/refuse`, { corps: {} })).status === 400);
  const ok = await appel("POST", `/api/admin/verifications/${v.id}/approve`, { corps: {} });
  verifie("approuver → badge (statut 2, un an)", ok.json?.request?.status === "approved" && (await prisma.user.findUnique({ where: { id: a.id } })).verificationStatut === 2, ok.json?.request);
  await appel("POST", `/api/admin/users/${a.id}/badge/revoke`, { corps: { reason: "banc" } });
  verifie("retirer le badge depuis la fiche → statut 4", (await prisma.user.findUnique({ where: { id: a.id } })).verificationStatut === 4);
  await appel("POST", `/api/admin/users/${a.id}/badge/restore`);
  verifie("le rendre → statut 2", (await prisma.user.findUnique({ where: { id: a.id } })).verificationStatut === 2);

  /* ─────────────── Stickers ─────────────── */
  titre("Stickers");
  const pack = await appel("POST", "/api/admin/sticker-packs", { corps: { name_i18n: { fr: "Banc Été" }, author: "Banc" } });
  nettoyage.packs.push(pack.json?.id);
  verifie("créer un pack → code dérivé du nom", pack.status === 201 && pack.json?.code === "banc-ete", pack.json);
  const envoi = new FormData();
  envoi.append("files", new Blob([PNG_ROUGE], { type: "image/png" }), "rouge.png");
  envoi.append("files", new Blob([PNG_BLEU], { type: "image/png" }), "bleu.png");
  envoi.append("files", new Blob([PNG_ROUGE], { type: "image/png" }), "rouge-encore.png");
  envoi.append("emoji", "😀");
  const st = await appel("POST", `/api/admin/sticker-packs/${pack.json.id}/stickers`, { brut: envoi });
  verifie("3 stickers, le doublon réutilisé", st.json?.stickers?.length === 3 && st.json.stickers[2].reutilise === true, st.json);
  const mauvais = new FormData();
  mauvais.append("files", new Blob([Buffer.from("texte")], { type: "text/plain" }), "x.txt");
  verifie("un fichier texte → 400", (await appel("POST", `/api/admin/sticker-packs/${pack.json.id}/stickers`, { brut: mauvais })).status === 400);
  const incomplet = await appel("POST", `/api/admin/sticker-packs/${pack.json.id}/publish`);
  verifie("publier sans vignette → 422 missing cover", incomplet.status === 422 && incomplet.json?.missing?.includes("cover"), incomplet.json);
  await appel("PATCH", `/api/admin/sticker-packs/${pack.json.id}`, { corps: { cover_sticker_id: st.json.stickers[0].id } });
  verifie("publier → statut 1", (await appel("POST", `/api/admin/sticker-packs/${pack.json.id}/publish`)).json?.status === 1);
  const dp = await appel("GET", `/api/admin/sticker-packs/${pack.json.id}`);
  nettoyage.assets.push(...new Set(dp.json?.stickers?.map((s) => s.assetId)));
  verifie("détail : vignette et 3 stickers", dp.json?.pack?.coverUrl && dp.json.stickers.length === 3, dp.json?.pack);
  verifie("fermé : l'application ne voit rien", (await appel("GET", "/api/stickers", { jeton: jetonMobile(a.id) })).json?.enabled === false);
  await appel("PUT", "/api/admin/sticker-settings", { corps: { enabled: true } });
  const app = await appel("GET", "/api/stickers", { jeton: jetonMobile(a.id) });
  verifie("ouvert : le pack publié est servi", app.json?.packs?.some((p) => p.code === "banc-ete" && p.stickers.length === 3), app.json);
  const fichierUrl = dp.json.stickers[1].url.replace(/^https?:\/\/[^/]+/, "");
  const img = await appel("GET", fichierUrl, { jeton: null });
  verifie("l'image se lit sans jeton", img.status === 200 && Buffer.compare(img.texte, PNG_BLEU) === 0, img.status);
  verifie("signaler un sticker → 201", (await appel("POST", "/api/stickers/signalements", { jeton: jetonMobile(a.id), corps: { assetId: dp.json.stickers[1].assetId, motif: "inapproprie" } })).status === 201);
  verifie("signalements de stickers : listé", (await appel("GET", "/api/admin/sticker-reports")).json?.reports?.some((x) => x.assetId === dp.json.stickers[1].assetId));
  await appel("POST", `/api/admin/sticker-assets/${dp.json.stickers[1].assetId}/takedown`);
  verifie("retiré → 410", (await appel("GET", fichierUrl, { jeton: null })).status === 410);
  verifie("archiver → statut 2", (await appel("POST", `/api/admin/sticker-packs/${pack.json.id}/archive`)).json?.status === 2);
  await appel("PUT", "/api/admin/sticker-settings", { corps: { enabled: false } });

  /* ─────────────── Trajets ─────────────── */
  titre("Trajets");
  const ja = jetonMobile(a.id);
  const tr = await appel("POST", "/api/trajets", { jeton: ja, corps: { nature: "taxi", dureeMinutes: 30 } });
  verifie("démarrer → 201", tr.status === 201 && tr.json?.statut === "ouvert", tr.json);
  verifie("un second trajet → 409", (await appel("POST", "/api/trajets", { jeton: ja, corps: { nature: "walk" } })).status === 409);
  verifie("positions → 3 reçues", (await appel("POST", `/api/trajets/${tr.json.id}/points`, { jeton: ja, corps: { points: [{ lat: 3.86, lng: 11.5 }, { lat: 3.87, lng: 11.51 }, { lat: 3.88, lng: 11.52 }] } })).json?.recus === 3);
  verifie("position hors du globe → 422", (await appel("POST", `/api/trajets/${tr.json.id}/points`, { jeton: ja, corps: { points: [{ lat: 95, lng: 0 }] } })).status === 422);
  verifie("le trajet d'un autre → 404", (await appel("POST", `/api/trajets/${tr.json.id}/arrive`, { jeton: jetonMobile(b.id) })).status === 404);
  await appel("POST", `/api/trajets/${tr.json.id}/alerte`, { jeton: ja });
  await appel("POST", `/api/trajets/${tr.json.id}/resolu`, { jeton: ja });
  verifie("arrivé → clos", (await appel("POST", `/api/trajets/${tr.json.id}/arrive`, { jeton: ja })).json?.statut === "clos");
  const ts = await appel("GET", "/api/admin/trips");
  verifie("statistiques : démarré, confirmé, alerte résolue", ts.json?.started >= 1 && ts.json.confirmed >= 1 && ts.json.alertsResolved >= 1, ts.json);
  const rt = await appel("GET", "/api/admin/trips/retention");
  verifie("rétention : les 3 positions des trajets clos", rt.json?.closed?.points >= 3, rt.json);
  const pg = await appel("POST", "/api/admin/trips/retention/purge", { corps: { scope: "all" } });
  verifie("purge totale → plus aucune position close", pg.json?.closed?.points === 0 && pg.json.runs?.[0]?.scope === "all", pg.json);
} catch (e) {
  echecs++;
  console.log(`\n\x1b[31mInterrompu : ${e?.stack ?? e}\x1b[0m`);
} finally {
  // Nettoyage best-effort.
  const sans = (p) => p.catch(() => {});
  for (const id of nettoyage.packs.filter(Boolean)) await sans(prisma.stickerPack.delete({ where: { id: BigInt(id) } }));
  for (const id of nettoyage.assets.filter(Boolean)) await sans(prisma.stickerAsset.delete({ where: { id: BigInt(id) } }));
  await sans(prisma.gestionReglage.deleteMany({ where: { cle: { in: ["stickers", "bienvenue.rattrapage"] } } }));
  for (const id of nettoyage.reunions) await sans(prisma.meeting.delete({ where: { idMeeting: id } }));
  await sans(prisma.reservedAlanyaPhone.deleteMany({ where: { phoneCanonical: { in: nettoyage.numeros } } }));
  await sans(prisma.trajet.deleteMany({ where: { userId: { in: comptes } } }));
  await sans(prisma.gestionSignalement.deleteMany({ where: { auteurId: { in: comptes } } }));
  await sans(prisma.gestionVerification.deleteMany({ where: { userId: { in: comptes } } }));
  await sans(prisma.gestionNumeroHistorique.deleteMany({ where: { userId: { in: comptes } } }));
  await sans(prisma.gestionBienvenueEnvoi.deleteMany({ where: { userId: { in: comptes } } }));
  for (const id of comptes) {
    const ids = (await prisma.participant.findMany({ where: { userId: id }, select: { convId: true } })).map((p) => p.convId);
    await sans(prisma.conversation.deleteMany({ where: { id: { in: [...ids, ...nettoyage.groupes] } } }));
    await sans(prisma.mediaFile.deleteMany({ where: { ownerId: id } }));
    await sans(prisma.refreshToken.deleteMany({ where: { userId: id } }));
  }
  await sans(prisma.user.deleteMany({ where: { id: { in: comptes } } }));
  await prisma.$disconnect();
}

console.log(echecs === 0 ? `\n\x1b[32mTout est vert (${total} vérifications).\x1b[0m` : `\n\x1b[31m${echecs} échec(s) sur ${total}.\x1b[0m`);
process.exit(echecs === 0 ? 0 : 1);
