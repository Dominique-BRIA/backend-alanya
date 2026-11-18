/**
 * GROUPES PRIVÉS ET PUBLICS, LIEN ET QR CODE D'UN GROUPE (18/11/2026).
 *
 *   ① la création : le type choisi, et un lien dès le départ ;
 *   ② qui voit le lien : ceux qui peuvent ajouter ; seul un admin le renouvelle ;
 *   ③ groupe PUBLIC : l'aperçu, puis on entre aussitôt (sans bannière), avec
 *     l'avis « a rejoint par le lien » ; redemander ne change rien ;
 *   ④ le type se change : les admins seuls ;
 *   ⑤ groupe PRIVÉ : la liste d'attente, refus, nouvelle demande, acceptation
 *     (avis avec l'admin), décision rejouée refusée ;
 *   ⑥ retirer sa demande ;
 *   ⑦ un membre RETIRÉ par un admin repasse par la liste, même en public ;
 *   ⑧ l'ajout par un membre (route refondue) marche toujours, et clôt la
 *     demande en attente ;
 *   ⑨ un lien renouvelé : l'ancien ne mène plus nulle part ;
 *   ⑩ la page de secours /g/<code>.
 *
 * ⚠️ JAMAIS SUR LA BASE DE PRODUCTION : il refuse toute base autre que
 * `alanya_banc` ou `alanya_dev`.
 *
 * Usage : API_URL=http://127.0.0.1:3100 node scripts/groupes-acces-banc.mjs
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
const MDP = "MotDePasseDeTest!2026";

async function compte(marque) {
  const email = `groupe-${marque}@e2ee.test`;
  const hash = await bcrypt.hash(MDP, 10);
  return prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, emailVerified: true, typeCompte: 0 },
    create: {
      email,
      nom: `Groupe ${marque}`,
      pseudo: `groupe_${marque}`,
      passwordHash: hash,
      publicNumber: `${Math.floor(10000000 + Math.random() * 89999999)}`,
      emailVerified: true,
      typeCompte: 0,
    },
  });
}

async function jeton(user) {
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: user.email, password: MDP, deviceId: `groupe-${user.id.slice(0, 8)}`, typeDevice: 0 }),
  });
  if (!r.ok) throw new Error(`login → ${r.status} ${await r.text()}`);
  return (await r.json()).accessToken;
}

async function appel(j, methode, chemin, corps) {
  const r = await fetch(`${API}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(j ? { Authorization: `Bearer ${j}` } : {}) },
    ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
  });
  const texte = await r.text();
  let json = null;
  try {
    json = JSON.parse(texte);
  } catch {}
  return { statut: r.status, json, texte };
}

async function nettoyer(ids) {
  const convs = await prisma.participant.findMany({ where: { userId: { in: ids } }, select: { convId: true } });
  await prisma.conversation.deleteMany({ where: { id: { in: convs.map((c) => c.convId) } } });
  await prisma.demandeAdhesion.deleteMany({ where: { userId: { in: ids } } });
}

const membre = (convId, userId) =>
  prisma.participant.findFirst({ where: { convId, userId, estMembre: true } });
const dernierAvis = async (convId) =>
  JSON.parse(
    (await prisma.message.findFirst({ where: { convId, type: "SYSTEM" }, orderBy: { createdAt: "desc" } }))
      ?.content ?? "{}",
  );

async function main() {
  console.log("\n\x1b[1m════ GROUPES PRIVÉS ET PUBLICS : LIEN, QR, LISTE D'ATTENTE ════\x1b[0m");

  const admin = await compte("admin");
  const simple = await compte("simple");
  const pub = await compte("public");
  const priv = await compte("prive");
  const autre = await compte("autre");
  const tous = [admin, simple, pub, priv, autre];
  await nettoyer(tous.map((u) => u.id));
  const j = {};
  for (const u of tous) j[u.id] = await jeton(u);

  titre("① La création");
  const c = await appel(j[admin.id], "POST", "/api/conversations", {
    name: "Groupe du banc",
    memberNumbers: [simple.publicNumber],
    acces: "public",
  });
  verifie("création d'un groupe public : 201", c.statut === 201, c.texte.slice(0, 200));
  const convId = c.json?.id;
  const conv0 = await prisma.conversation.findUnique({ where: { id: convId } });
  verifie("acces = public, et un code de lien existe", conv0?.acces === "public" && !!conv0?.codeLien, JSON.stringify(conv0?.acces));
  const cPrive = await appel(j[admin.id], "POST", "/api/conversations", {
    name: "Groupe par défaut",
    memberNumbers: [simple.publicNumber],
  });
  const defaut = await prisma.conversation.findUnique({ where: { id: cPrive.json?.id } });
  verifie("sans précision, le groupe est privé", defaut?.acces === "prive", defaut?.acces);
  const mauvais = await appel(j[admin.id], "POST", "/api/conversations", {
    name: "x",
    memberNumbers: [simple.publicNumber],
    acces: "secret",
  });
  verifie("un type inconnu est refusé", mauvais.statut >= 400 && mauvais.statut < 500, `HTTP ${mauvais.statut}`);

  titre("② Qui voit le lien");
  const lA = await appel(j[admin.id], "GET", `/api/conversations/${convId}/lien`);
  verifie(
    "l'admin le voit : https://alanyavox.com/g/<code>",
    lA.statut === 200 && lA.json?.lien === `https://alanyavox.com/g/${conv0.codeLien}`,
    lA.texte.slice(0, 200),
  );
  const lS = await appel(j[simple.id], "GET", `/api/conversations/${convId}/lien`);
  verifie("un simple membre (seuls les admins ajoutent) : 403", lS.statut === 403, `HTTP ${lS.statut}`);
  const lO = await appel(j[autre.id], "GET", `/api/conversations/${convId}/lien`);
  verifie("quelqu'un d'extérieur : 403", lO.statut === 403, `HTTP ${lO.statut}`);
  await prisma.conversation.update({ where: { id: convId }, data: { adminsSeulsAjoutent: false } });
  const lS2 = await appel(j[simple.id], "GET", `/api/conversations/${convId}/lien`);
  verifie("« seuls les admins ajoutent » levé : le membre le voit", lS2.statut === 200, `HTTP ${lS2.statut}`);
  await prisma.conversation.update({ where: { id: convId }, data: { adminsSeulsAjoutent: true } });
  const rS = await appel(j[simple.id], "POST", `/api/conversations/${convId}/lien`);
  verifie("un simple membre ne renouvelle pas : 403", rS.statut === 403, `HTTP ${rS.statut}`);
  const sansCode = await prisma.conversation.update({
    where: { id: cPrive.json.id },
    data: { codeLien: null },
  });
  const lPar = await appel(j[admin.id], "GET", `/api/conversations/${sansCode.id}/lien`);
  verifie("un groupe d'avant (sans code) en reçoit un à la demande", lPar.statut === 200 && !!lPar.json?.code, lPar.texte.slice(0, 160));

  titre("③ Groupe public : on entre aussitôt");
  const code = conv0.codeLien;
  const ap = await appel(j[pub.id], "GET", `/api/groupes/lien/${code}`);
  verifie(
    "l'aperçu : nom, 2 membres, public, état « aucun »",
    ap.statut === 200 && ap.json?.nom === "Groupe du banc" && ap.json?.membres === 2 && ap.json?.acces === "public" && ap.json?.etat === "aucun",
    ap.texte.slice(0, 200),
  );
  verifie("l'aperçu ne liste pas les membres", ap.json && !("members" in ap.json) && !("participants" in ap.json));
  const rj = await appel(j[pub.id], "POST", `/api/groupes/lien/${code}/rejoindre`);
  verifie("rejoindre : membre", rj.statut === 200 && rj.json?.etat === "membre" && rj.json?.deja === false, rj.texte.slice(0, 160));
  const p = await membre(convId, pub.id);
  verifie("il est membre, sans bannière « Rester / Quitter »", !!p && p.arriveeAConfirmer === false, JSON.stringify(p?.arriveeAConfirmer));
  const avis = await dernierAvis(convId);
  verifie("l'avis : member_joined_link, sans auteur", avis.code === "member_joined_link" && avis.target && !avis.actor, JSON.stringify(avis));
  const rj2 = await appel(j[pub.id], "POST", `/api/groupes/lien/${code}/rejoindre`);
  verifie("redemander : déjà membre, rien ne change", rj2.json?.etat === "membre" && rj2.json?.deja === true, rj2.texte.slice(0, 160));
  const inconnu = await appel(j[pub.id], "GET", `/api/groupes/lien/AAAAAAAAAAAAAAAAAAAAAA`);
  verifie("un code inconnu : 404 LIEN_INVALIDE", inconnu.statut === 404 && inconnu.json?.error?.code === "LIEN_INVALIDE", inconnu.texte.slice(0, 160));
  const malforme = await appel(j[pub.id], "GET", `/api/groupes/lien/x`);
  verifie("un code mal formé : 404", malforme.statut === 404, `HTTP ${malforme.statut}`);

  titre("④ Changer le type");
  const pS = await appel(j[simple.id], "PATCH", `/api/conversations/${convId}`, { acces: "prive" });
  verifie("un simple membre : 403", pS.statut === 403, `HTTP ${pS.statut}`);
  const pX = await appel(j[admin.id], "PATCH", `/api/conversations/${convId}`, { acces: "ouvert" });
  verifie("une valeur inconnue : 400", pX.statut === 400, `HTTP ${pX.statut}`);
  const pA = await appel(j[admin.id], "PATCH", `/api/conversations/${convId}`, { acces: "prive" });
  verifie("l'admin passe le groupe en privé", pA.statut === 200 && pA.json?.acces === "prive", pA.texte.slice(0, 160));

  titre("⑤ Groupe privé : la liste d'attente");
  const d1 = await appel(j[priv.id], "POST", `/api/groupes/lien/${code}/rejoindre`);
  verifie("rejoindre : en attente", d1.statut === 200 && d1.json?.etat === "attente", d1.texte.slice(0, 160));
  verifie("il n'est PAS membre", !(await membre(convId, priv.id)));
  await appel(j[priv.id], "POST", `/api/groupes/lien/${code}/rejoindre`);
  const nb = await prisma.demandeAdhesion.count({ where: { convId, userId: priv.id } });
  verifie("redemander ne crée pas de doublon", nb === 1, `${nb} lignes`);
  const apV = await appel(j[priv.id], "GET", `/api/groupes/lien/${code}`);
  verifie("l'aperçu dit « attente »", apV.json?.etat === "attente", apV.texte.slice(0, 160));
  const mb = await appel(j[admin.id], "GET", `/api/conversations/${convId}/members`);
  verifie(
    "GET members (admin) : privé, 1 demande en attente, lien partageable",
    mb.json?.groupe?.acces === "prive" && mb.json?.groupe?.demandesEnAttente === 1 && mb.json?.groupe?.peutPartagerLien === true,
    JSON.stringify(mb.json?.groupe),
  );
  const mbS = await appel(j[simple.id], "GET", `/api/conversations/${convId}/members`);
  verifie("GET members (simple membre) : 0 demande visible", mbS.json?.groupe?.demandesEnAttente === 0, JSON.stringify(mbS.json?.groupe));
  const lsS = await appel(j[simple.id], "GET", `/api/conversations/${convId}/demandes`);
  verifie("la liste, pour un simple membre : 403", lsS.statut === 403, `HTTP ${lsS.statut}`);
  const ls = await appel(j[admin.id], "GET", `/api/conversations/${convId}/demandes`);
  const dem = ls.json?.demandes?.[0];
  verifie(
    "la liste, pour l'admin : le demandeur, son numéro",
    ls.statut === 200 && ls.json.demandes.length === 1 && dem?.userId === priv.id && dem?.publicNumber === priv.publicNumber,
    ls.texte.slice(0, 200),
  );
  const decS = await appel(j[simple.id], "POST", `/api/conversations/${convId}/demandes/${dem.id}`, { decision: "accepter" });
  verifie("un simple membre ne décide pas : 403", decS.statut === 403, `HTTP ${decS.statut}`);
  const decX = await appel(j[admin.id], "POST", `/api/conversations/${convId}/demandes/${dem.id}`, { decision: "peut-être" });
  verifie("une décision inconnue : 400", decX.statut === 400, `HTTP ${decX.statut}`);
  const ref = await appel(j[admin.id], "POST", `/api/conversations/${convId}/demandes/${dem.id}`, { decision: "refuser" });
  verifie("l'admin refuse", ref.statut === 200 && ref.json?.statut === "refusee", ref.texte.slice(0, 160));
  verifie("toujours pas membre", !(await membre(convId, priv.id)));
  const ref2 = await appel(j[admin.id], "POST", `/api/conversations/${convId}/demandes/${dem.id}`, { decision: "accepter" });
  verifie("décider une seconde fois : 409 DEJA_TRAITEE", ref2.statut === 409 && ref2.json?.error?.code === "DEJA_TRAITEE", ref2.texte.slice(0, 160));
  const apR = await appel(j[priv.id], "GET", `/api/groupes/lien/${code}`);
  verifie("après un refus, l'aperçu redit « aucun »", apR.json?.etat === "aucun", apR.texte.slice(0, 160));
  const d2 = await appel(j[priv.id], "POST", `/api/groupes/lien/${code}/rejoindre`);
  verifie("il redemande : en attente", d2.json?.etat === "attente", d2.texte.slice(0, 160));
  const ls2 = await appel(j[admin.id], "GET", `/api/conversations/${convId}/demandes`);
  const dem2 = ls2.json?.demandes?.[0];
  verifie("même ligne, remise en attente", dem2?.id === dem.id, `${dem2?.id} ≠ ${dem.id}`);
  const acc = await appel(j[admin.id], "POST", `/api/conversations/${convId}/demandes/${dem2.id}`, { decision: "accepter" });
  verifie("l'admin accepte", acc.statut === 200 && acc.json?.statut === "acceptee", acc.texte.slice(0, 160));
  const pv = await membre(convId, priv.id);
  verifie("il est membre, sans bannière", !!pv && pv.arriveeAConfirmer === false);
  const avis2 = await dernierAvis(convId);
  verifie("l'avis nomme l'admin qui a accepté", avis2.code === "member_joined_link" && !!avis2.actor, JSON.stringify(avis2));
  const ls3 = await appel(j[admin.id], "GET", `/api/conversations/${convId}/demandes`);
  verifie("la liste est vide", ls3.json?.demandes?.length === 0, ls3.texte.slice(0, 160));

  titre("⑥ Retirer sa demande");
  const d3 = await appel(j[autre.id], "POST", `/api/groupes/lien/${code}/rejoindre`);
  verifie("une demande en attente", d3.json?.etat === "attente");
  const an = await appel(j[autre.id], "DELETE", `/api/groupes/lien/${code}/rejoindre`);
  verifie("la retirer : état « aucun »", an.statut === 200 && an.json?.etat === "aucun", an.texte.slice(0, 160));
  const an2 = await appel(j[autre.id], "DELETE", `/api/groupes/lien/${code}/rejoindre`);
  verifie("rien à retirer : 404", an2.statut === 404, `HTTP ${an2.statut}`);

  titre("⑦ Un membre retiré par un admin repasse par la liste");
  const ret = await appel(j[admin.id], "DELETE", `/api/conversations/${convId}/members?userId=${pub.id}`);
  verifie("l'admin retire « public »", ret.statut === 200, ret.texte.slice(0, 160));
  await appel(j[admin.id], "PATCH", `/api/conversations/${convId}`, { acces: "public" });
  const rv = await appel(j[pub.id], "POST", `/api/groupes/lien/${code}/rejoindre`);
  verifie("groupe public, mais il était exclu : en attente", rv.json?.etat === "attente", rv.texte.slice(0, 160));
  verifie("il n'est pas revenu", !(await membre(convId, pub.id)));
  // Un départ VOLONTAIRE, lui, n'empêche pas de revenir par le lien.
  await appel(j[priv.id], "DELETE", `/api/conversations/${convId}/members?userId=${priv.id}`);
  const rp = await appel(j[priv.id], "POST", `/api/groupes/lien/${code}/rejoindre`);
  verifie("parti de lui-même, il revient directement (public)", rp.json?.etat === "membre", rp.texte.slice(0, 160));

  titre("⑧ L'ajout par un membre (route refondue)");
  const aj = await appel(j[admin.id], "POST", `/api/conversations/${convId}/members`, { publicNumbers: [pub.publicNumber] });
  verifie("l'admin ajoute l'exclu : 200", aj.statut === 200, aj.texte.slice(0, 160));
  const pb = await membre(convId, pub.id);
  verifie("il est membre, AVEC la bannière (on l'a ajouté)", !!pb && pb.arriveeAConfirmer === true);
  const dp = await prisma.demandeAdhesion.findUnique({ where: { convId_userId: { convId, userId: pub.id } } });
  verifie("sa demande en attente est close", dp?.statut === "acceptee", dp?.statut);
  const avis3 = await dernierAvis(convId);
  verifie("l'avis reste member_added", avis3.code === "member_added", JSON.stringify(avis3));

  titre("⑨ Renouveler le lien");
  const rn = await appel(j[admin.id], "POST", `/api/conversations/${convId}/lien`);
  verifie("l'admin renouvelle : un autre code", rn.statut === 200 && rn.json?.code && rn.json.code !== code, rn.texte.slice(0, 160));
  const vieux = await appel(j[autre.id], "POST", `/api/groupes/lien/${code}/rejoindre`);
  verifie("l'ancien lien : 404", vieux.statut === 404, `HTTP ${vieux.statut}`);
  const neuf = await appel(j[autre.id], "POST", `/api/groupes/lien/${rn.json.code}/rejoindre`);
  verifie("le nouveau lien fait entrer", neuf.json?.etat === "membre", neuf.texte.slice(0, 160));

  titre("⑩ La page de secours /g/<code>");
  const page = await fetch(`${API}/g/${rn.json.code}`, { headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 14)" } });
  const html = await page.text();
  verifie(
    "200, le nom du groupe, « Ouvrir dans l'application », le web vers /webapp/g/",
    page.status === 200 && html.includes("Groupe du banc") && html.includes("intent://alanyavox.com/g/") && html.includes(`/webapp/g/${rn.json.code}`),
    `HTTP ${page.status}`,
  );
  const morte = await fetch(`${API}/g/${code}`);
  const htmlMorte = await morte.text();
  verifie("l'ancien code : « n'est plus valable »", htmlMorte.includes("plus valable"), `HTTP ${morte.status}`);

  await nettoyer(tous.map((u) => u.id));
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
