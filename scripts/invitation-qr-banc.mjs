/**
 * LE BANC DES INVITATIONS QR À USAGE UNIQUE (15 minutes).
 *
 *   ① créer : un jeton de 22 caractères, un lien /i/, 15 minutes de vie ;
 *   ② consulter : le nom et la photo du créateur, JAMAIS son Alanya ID ;
 *   ③ le créateur ne peut pas utiliser sa propre invitation — et elle reste
 *      intacte pour les autres ;
 *   ④ utiliser : contacts dans les DEUX sens, conversation rendue, Alanya ID
 *      révélé seulement là ;
 *   ⑤ rejouer par la même personne : même conversation, pas d'erreur ;
 *   ⑥ une autre personne ensuite : refusée (déjà utilisée) ;
 *   ⑦ cinq personnes au MÊME instant : une seule passe ;
 *   ⑧ expirée : refusée, en consultation comme en utilisation ;
 *   ⑨ blocage : refusée, et l'invitation n'est pas brûlée ;
 *   ⑩ jeton inconnu ou mal formé : 404 ; sans connexion : 401 ;
 *   ⑪ frein anti-robot : la 31ᵉ création de l'heure est refusée ;
 *   ⑫ ménage : une invitation périmée depuis plus d'un jour disparaît ;
 *   ⑬ la BASE refuse les états incohérents, même si le code se trompait.
 *
 * ⚠️ CHAQUE REFUS A SON TÉMOIN : le même geste par quelqu'un qui en a le droit
 * doit passer. Une garde qui refuse tout passerait les refus sans rien
 * protéger.
 *
 * Usage : node --env-file=.env scripts/invitation-qr-banc.mjs
 *         (backend démarré ; API_URL, défaut http://localhost:3000)
 */
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

const API = process.env.API_URL ?? "http://localhost:3000";
const prisma = new PrismaClient();

let echecs = 0;

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

const jetonAcces = (compte) =>
  jwt.sign({ sub: compte.id, scope: "access" }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: "15m",
  });

async function appel(chemin, compte, methode = "GET") {
  const r = await fetch(`${API}${chemin}`, {
    method: methode,
    headers: compte ? { authorization: `Bearer ${jetonAcces(compte)}` } : {},
  });
  const json = await r.json().catch(() => ({}));
  return { statut: r.status, code: json?.error?.code, json };
}

const creer = (c) => appel("/api/invitations", c, "POST");
const consulter = (c, j) => appel(`/api/invitations/${j}`, c);
const utiliser = (c, j) => appel(`/api/invitations/${j}/utiliser`, c, "POST");

const comptes = [];
async function nouveauCompte(nom) {
  const c = await prisma.user.create({
    data: {
      publicNumber: `7${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
      pseudo: `Banc invitation ${nom}`,
    },
  });
  comptes.push(c);
  return c;
}

const estContact = async (de, vers) =>
  Boolean(
    await prisma.contact.findUnique({
      where: { userId_contactId: { userId: de.id, contactId: vers.id } },
    }),
  );

const ligne = (jeton) => prisma.invitationQr.findUnique({ where: { jeton } });

try {
  const [A, B, C] = [await nouveauCompte("A"), await nouveauCompte("B"), await nouveauCompte("C")];

  titre("① Créer");
  const r1 = await creer(A);
  const j1 = r1.json.jeton;
  verifie("201", r1.statut === 201, r1);
  verifie("jeton de 22 caractères base64url", /^[A-Za-z0-9_-]{22}$/.test(j1 ?? ""), j1);
  verifie("lien https://alanyavox.com/i/<jeton>", r1.json.lien === `https://alanyavox.com/i/${j1}`);
  const vie = new Date(r1.json.expireLe).getTime() - Date.now();
  verifie("expire dans 15 minutes", vie > 14 * 60_000 && vie <= 15 * 60_000, vie);
  verifie("le lien ne contient pas l'Alanya ID", !r1.json.lien.includes(A.publicNumber));

  titre("② Consulter (sans utiliser)");
  const r2 = await consulter(B, j1);
  verifie("200", r2.statut === 200, r2);
  verifie("le nom du créateur", r2.json.createur?.pseudo === A.pseudo, r2.json);
  verifie("PAS son Alanya ID", !JSON.stringify(r2.json).includes(A.publicNumber), r2.json);
  verifie("estLaMienne = faux", r2.json.estLaMienne === false);
  verifie("consulter ne consomme pas", (await ligne(j1)).utiliseeLe === null);

  titre("③ Le créateur et sa propre invitation");
  const r3a = await consulter(A, j1);
  verifie("consultation : estLaMienne = vrai", r3a.json.estLaMienne === true, r3a);
  const r3 = await utiliser(A, j1);
  verifie("utilisation refusée (400 SELF)", r3.statut === 400 && r3.code === "SELF", r3);
  verifie("l'invitation reste intacte", (await ligne(j1)).utiliseeLe === null);

  titre("④ Utiliser");
  const r4 = await utiliser(B, j1);
  verifie("200 (témoin du ③ : B y a droit)", r4.statut === 200, r4);
  verifie("conversation rendue", typeof r4.json.convId === "string", r4.json);
  verifie("Alanya ID révélé ici", r4.json.user?.publicNumber === A.publicNumber, r4.json);
  verifie("B a A dans ses contacts", await estContact(B, A));
  verifie("A a B dans ses contacts (réciproque)", await estContact(A, B));
  const l4 = await ligne(j1);
  verifie("utilisée par B, datée", l4.utiliseePar === B.id && l4.utiliseeLe !== null, l4);

  titre("⑤ Rejouer par la même personne");
  const r5 = await utiliser(B, j1);
  verifie("200, même conversation", r5.statut === 200 && r5.json.convId === r4.json.convId, r5);
  const r5b = await consulter(B, j1);
  verifie("consultation : dejaUtiliseeParMoi", r5b.statut === 200 && r5b.json.dejaUtiliseeParMoi === true, r5b);

  titre("⑥ Une autre personne ensuite");
  const r6 = await utiliser(C, j1);
  verifie("410 INVITATION_UTILISEE", r6.statut === 410 && r6.code === "INVITATION_UTILISEE", r6);
  const r6b = await consulter(C, j1);
  verifie("consultation : 410 aussi", r6b.statut === 410, r6b);
  verifie("C n'a pas A dans ses contacts", !(await estContact(C, A)));

  titre("⑦ Cinq personnes au même instant");
  const j7 = (await creer(A)).json.jeton;
  const foule = [];
  for (let i = 0; i < 5; i++) foule.push(await nouveauCompte(`foule${i}`));
  const r7 = await Promise.all(foule.map((f) => utiliser(f, j7)));
  const gagnants = r7.filter((r) => r.statut === 200).length;
  const perdants = r7.filter((r) => r.statut === 410).length;
  verifie("exactement UNE passe", gagnants === 1, r7.map((r) => r.statut));
  verifie("les quatre autres : 410", perdants === 4, r7.map((r) => r.statut));
  const contactsDeA = await prisma.contact.count({
    where: { userId: A.id, contactId: { in: foule.map((f) => f.id) } },
  });
  verifie("A n'a reçu qu'UN contact de la foule", contactsDeA === 1, contactsDeA);

  titre("⑧ Expirée");
  const j8 = (await creer(A)).json.jeton;
  await prisma.invitationQr.update({
    where: { jeton: j8 },
    data: { creeLe: new Date(Date.now() - 20 * 60_000), expireLe: new Date(Date.now() - 60_000) },
  });
  const r8a = await consulter(C, j8);
  verifie("consultation : 410 INVITATION_EXPIREE", r8a.statut === 410 && r8a.code === "INVITATION_EXPIREE", r8a);
  const r8 = await utiliser(C, j8);
  verifie("utilisation : 410 INVITATION_EXPIREE", r8.statut === 410 && r8.code === "INVITATION_EXPIREE", r8);
  verifie("non consommée", (await ligne(j8)).utiliseeLe === null);

  titre("⑨ Blocage");
  const [E, F] = [await nouveauCompte("E"), await nouveauCompte("F")];
  await prisma.blocked.create({ data: { alanyaID: A.id, idCallerBlock: E.id } });
  const j9 = (await creer(A)).json.jeton;
  const r9a = await consulter(E, j9);
  verifie("consultation : 403", r9a.statut === 403 && r9a.code === "INVITATION_INDISPONIBLE", r9a);
  const r9 = await utiliser(E, j9);
  verifie("utilisation : 403", r9.statut === 403, r9);
  verifie("l'invitation n'est pas brûlée", (await ligne(j9)).utiliseeLe === null);
  const r9t = await utiliser(F, j9);
  verifie("témoin : F (non bloqué) l'utilise", r9t.statut === 200, r9t);

  titre("⑩ Jeton inconnu, mal formé, sans connexion");
  const r10a = await consulter(B, "AAAAAAAAAAAAAAAAAAAAAA");
  verifie("inconnu : 404", r10a.statut === 404 && r10a.code === "INVITATION_INCONNUE", r10a);
  const r10b = await utiliser(B, "pas-un-jeton!");
  verifie("mal formé : 404", r10b.statut === 404, r10b);
  const r10c = await appel("/api/invitations", null, "POST");
  verifie("création sans connexion : 401", r10c.statut === 401, r10c);
  const r10d = await consulter(null, j1);
  verifie("consultation sans connexion : 401", r10d.statut === 401, r10d);

  titre("⑪ Frein anti-robot (30 par heure)");
  const [G, H] = [await nouveauCompte("G"), await nouveauCompte("H")];
  const statuts = [];
  for (let i = 0; i < 31; i++) statuts.push((await creer(G)).statut);
  verifie("30 créations passent", statuts.slice(0, 30).every((s) => s === 201), statuts);
  verifie("la 31ᵉ : 429", statuts[30] === 429, statuts[30]);
  const r11 = await creer(H);
  verifie("témoin : un autre compte crée toujours", r11.statut === 201, r11);

  titre("⑫ Ménage des invitations périmées");
  const vieux = "banc_menage_" + Date.now().toString(36).padStart(10, "0");
  await prisma.invitationQr.create({
    data: {
      jeton: vieux,
      createurId: A.id,
      creeLe: new Date(Date.now() - 3 * 86_400_000),
      expireLe: new Date(Date.now() - 2 * 86_400_000),
    },
  });
  const recent = "banc_recent_" + Date.now().toString(36).padStart(10, "0");
  await prisma.invitationQr.create({
    data: {
      jeton: recent,
      createurId: A.id,
      creeLe: new Date(Date.now() - 3_600_000),
      expireLe: new Date(Date.now() - 1_800_000),
    },
  });
  await creer(B);
  verifie("périmée depuis 2 jours : supprimée", (await ligne(vieux)) === null);
  verifie("témoin : périmée depuis 30 min : gardée", (await ligne(recent)) !== null);

  titre("⑬ La base refuse les états incohérents");
  const j13 = (await creer(A)).json.jeton;
  const refuse = async (libelle, donnees) => {
    const err = await prisma.invitationQr
      .update({ where: { jeton: j13 }, data: donnees })
      .then(() => null, (e) => e);
    verifie(libelle, err !== null, "accepté par la base");
  };
  await refuse("utilisée sans utilisateur", { utiliseeLe: new Date() });
  await refuse("utilisateur sans date", { utiliseePar: B.id });
  await refuse("utilisée par son créateur", { utiliseeLe: new Date(), utiliseePar: A.id });
  await refuse("expirée avant sa création", { expireLe: new Date(Date.now() - 86_400_000) });
  const ok13 = await prisma.invitationQr
    .update({ where: { jeton: j13 }, data: { utiliseeLe: new Date(), utiliseePar: C.id } })
    .then(() => true, () => false);
  verifie("témoin : une utilisation complète est acceptée", ok13);
} finally {
  // CASCADE : supprimer les comptes emporte leurs invitations, contacts,
  // blocages. Les conversations, elles, restent (sans participants utiles).
  for (const c of comptes) {
    await prisma.user.delete({ where: { id: c.id } }).catch(() => undefined);
  }
  await prisma.$disconnect();
}

console.log(echecs === 0 ? "\n\x1b[32mTout passe.\x1b[0m" : `\n\x1b[31m${echecs} échec(s).\x1b[0m`);
process.exit(echecs === 0 ? 0 : 1);
