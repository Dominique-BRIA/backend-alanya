/**
 * BANC — LA RECHERCHE WEB DE L'ASSISTANT ALANYA (14/11/2026).
 *
 * Sans Internet ni clé : un petit serveur local joue les sites ET notre
 * moteur, et le modèle est simulé. Vérifie les gardes réseau, l'extraction du
 * texte, la lecture (redirections, gzip, erreurs), la recherche, et la boucle
 * d'outils de l'assistant.
 *
 * Lancer :
 *   node --import ./scripts/resoudre-ts.mjs scripts/recherche-web-banc.ts
 */
import http from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { estPublique, rechercheSure, AdresseRefusee } from "../src/lib/web/adresse-publique.ts";
import { extraireTexte, lirePage, verifierAdresse, LectureImpossible } from "../src/lib/web/lecture-page.ts";
import { rechercherWeb } from "../src/lib/web/recherche.ts";
import { executerOutil } from "../src/lib/web/outils-assistant.ts";

let ok = 0;
let ko = 0;
function verifie(nom: string, condition: boolean, detail = "") {
  if (condition) {
    ok++;
    console.log(`  ✓ ${nom}`);
  } else {
    ko++;
    console.log(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`);
  }
}
async function refuse(nom: string, promesse: Promise<unknown>, motif?: RegExp) {
  try {
    await promesse;
    verifie(nom, false, "aucune erreur");
  } catch (e) {
    const m = (e as Error).message;
    verifie(nom, e instanceof LectureImpossible && (!motif || motif.test(m)), m);
  }
}

console.log("Adresses publiques");
for (const ip of ["8.8.8.8", "141.95.170.46", "2001:4860:4860::8888", "1.1.1.1"]) verifie(`${ip} publique`, estPublique(ip));
for (const ip of [
  "127.0.0.1", "10.2.3.4", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
  "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1",
  "::ffff:7f00:1", "64:ff9b::a00:1", "2001:db8::1", "pas-une-ip",
]) verifie(`${ip} refusée`, !estPublique(ip));
verifie("172.32.0.1 publique (hors 172.16/12)", estPublique("172.32.0.1"));

console.log("Vérification d'adresse");
for (const [adresse, motif] of [
  ["file:///etc/passwd", /http et https/],
  ["ftp://exemple.org/", /http et https/],
  ["http://localhost:3000/api", /publique/],
  ["http://127.0.0.1/", /publique/],
  ["http://[::1]/", /publique/],
  ["http://169.254.169.254/metadata", /publique/],
  ["https://moi:secret@exemple.org/", /identifiants/],
  ["http://exemple.org:22/", /port/],
  ["pas une adresse", /invalide/],
] as const) {
  let message = "";
  try {
    verifierAdresse(adresse);
  } catch (e) {
    message = (e as Error).message;
  }
  verifie(`${adresse} refusée`, motif.test(message), message || "acceptée");
}
verifie("https://exemple.org/page acceptée", verifierAdresse("https://exemple.org/page").hostname === "exemple.org");
verifie("port 8080 accepté", verifierAdresse("http://exemple.org:8080/").port === "8080");

console.log("Résolution sûre");
await new Promise<void>((fin) =>
  rechercheSure("localhost", {}, (err) => {
    verifie("un nom qui mène à la machine est refusé à la connexion", err instanceof AdresseRefusee, String(err));
    fin();
  }),
);

console.log("Extraction du texte");
const article = `<!doctype html><html><head><title>Prix du ciment &amp; du fer</title>
<script>alert("piège")</script><style>p{color:red}</style></head>
<body><header>Menu du site</header><nav><a href="/">Accueil</a></nav>
<article><h1>Le ciment à Douala</h1><p>Le sac de 50&nbsp;kg coûte <b>5 000 FCFA</b> en novembre.</p>
<p>${"Texte long. ".repeat(60)}</p><ul><li>Cimencam</li><li>Dangote</li></ul></article>
<footer>© Pied de page</footer></body></html>`;
const ex = extraireTexte(article);
verifie("titre décodé", ex.titre === "Prix du ciment & du fer", ex.titre);
verifie("texte de l'article", ex.texte.includes("Le sac de 50 kg coûte 5 000 FCFA en novembre."), ex.texte.slice(0, 200));
verifie("titre de section marqué", ex.texte.includes("# Le ciment à Douala"));
verifie("liste en lignes", ex.texte.includes("- Cimencam") && ex.texte.includes("- Dangote"));
verifie("ni script ni style", !ex.texte.includes("piège") && !ex.texte.includes("color:red"));
verifie("ni menu ni pied de page", !ex.texte.includes("Menu du site") && !ex.texte.includes("Pied de page"));

// ── Un faux site, et un faux moteur ─────────────────────────────────────────
const serveur = http.createServer((req, res) => {
  const chemin = req.url ?? "/";
  if (chemin.startsWith("/search")) {
    const q = new URL(chemin, "http://x").searchParams.get("q");
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({
        results: [
          { title: "Ciment <b>Douala</b>", url: "https://exemple.org/ciment", content: `Pour « ${q} » : 5 000 FCFA` },
          { title: "Doublon", url: "https://exemple.org/ciment", content: "même lien" },
          { title: "Pas web", url: "javascript:alert(1)", content: "refusé" },
          { title: "Fer &amp; acier", url: "https://exemple.org/fer", content: "Le fer" },
        ],
      }),
    );
  }
  if (chemin === "/article") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(article);
  }
  if (chemin === "/compresse") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Encoding", "gzip");
    return res.end(gzipSync(Buffer.from(article)));
  }
  if (chemin === "/notes.txt") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end("Notes brutes, sans balise.");
  }
  if (chemin === "/latin1") {
    res.setHeader("Content-Type", "text/html; charset=iso-8859-1");
    return res.end(Buffer.from("<html><body><p>Caf\xe9 cr\xe8me</p></body></html>", "latin1"));
  }
  if (chemin === "/vers-article") {
    res.writeHead(302, { Location: "/article" });
    return res.end();
  }
  if (chemin === "/vers-fichier") {
    res.writeHead(302, { Location: "file:///etc/passwd" });
    return res.end();
  }
  if (chemin === "/boucle") {
    res.writeHead(302, { Location: "/boucle" });
    return res.end();
  }
  if (chemin === "/rapport.pdf") {
    res.setHeader("Content-Type", "application/pdf");
    return res.end("%PDF-1.4 …");
  }
  if (chemin === "/image") {
    res.setHeader("Content-Type", "image/png");
    return res.end(Buffer.alloc(10));
  }
  res.writeHead(404);
  res.end("absente");
});
await new Promise<void>((r) => serveur.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;

try {
  console.log("Lecture de pages");
  const page = await lirePage(`${base}/article`, true);
  verifie("page HTML lue", page.titre === "Prix du ciment & du fer" && page.texte.includes("5 000 FCFA"));
  verifie("page compressée lue", (await lirePage(`${base}/compresse`, true)).texte.includes("5 000 FCFA"));
  verifie("texte brut lu", (await lirePage(`${base}/notes.txt`, true)).texte === "Notes brutes, sans balise.");
  verifie("encodage latin-1 respecté", (await lirePage(`${base}/latin1`, true)).texte.includes("Café crème"));
  const suivie = await lirePage(`${base}/vers-article`, true);
  verifie("redirection suivie, adresse finale rendue", suivie.adresse === `${base}/article`, suivie.adresse);
  await refuse("redirection vers file:// refusée", lirePage(`${base}/vers-fichier`, true), /http et https/);
  await refuse("boucle de redirections arrêtée", lirePage(`${base}/boucle`, true), /redirections/);
  await refuse("page absente signalée", lirePage(`${base}/absente`, true), /404/);
  await refuse("PDF signalé", lirePage(`${base}/rapport.pdf`, true), /PDF/);
  await refuse("image refusée", lirePage(`${base}/image`, true), /type de contenu/);
  await refuse("sans dérogation, la machine elle-même est refusée", lirePage(`${base}/article`), /publique/);

  console.log("Recherche");
  const resultats = await rechercherWeb("prix ciment", base);
  verifie("résultats nettoyés", resultats[0]?.titre === "Ciment Douala" && resultats[0]?.extrait.includes("prix ciment"));
  verifie("doublon et lien non web écartés", resultats.length === 2, JSON.stringify(resultats));
  verifie("entités décodées", resultats[1]?.titre === "Fer & acier");

  console.log("Outils");
  verifie("outil inconnu", "erreur" in (await executerOutil("effacer_tout", {}, base)));
  verifie("recherche vide", "erreur" in (await executerOutil("rechercher_web", { requete: " " }, base)));
  const lecture = await executerOutil("lire_page", { adresse: "http://169.254.169.254/latest" }, base);
  verifie("lecture piégée rendue en erreur, sans lever", String(lecture.erreur).includes("publique"), JSON.stringify(lecture));
  const trouve = await executerOutil("rechercher_web", { requete: "prix ciment" }, base);
  verifie("recherche rendue avec l'avertissement", Array.isArray(trouve.resultats) && typeof trouve.avertissement === "string");

  console.log("Boucle de l'assistant (modèle simulé)");
  process.env.ASSISTANT_API_KEY = "cle-de-test";
  process.env.ASSISTANT_MOTEUR_RECHERCHE = base;
  const appels: { tools?: unknown; toolConfig?: { functionCallingConfig?: { mode?: string } }; contents: unknown[]; systemInstruction: { parts: { text: string }[] } }[] = [];
  const vraiFetch = globalThis.fetch;
  let reponses: unknown[] = [];
  globalThis.fetch = (async (entree: string | URL | Request, init?: RequestInit) => {
    const adresse = String(entree instanceof Request ? entree.url : entree);
    if (!adresse.includes("generateContent")) return vraiFetch(entree, init);
    appels.push(JSON.parse(String(init?.body)));
    const suivante = reponses.shift();
    return new Response(JSON.stringify(suivante), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const { generateReply } = await import("../src/lib/assistant.ts");
  reponses = [
    {
      candidates: [{ content: { role: "model", parts: [
        { functionCall: { name: "rechercher_web", args: { requete: "prix ciment Douala" } }, thoughtSignature: "sig-1" },
      ] } }],
    },
    { candidates: [{ content: { role: "model", parts: [{ text: "Environ 5 000 FCFA.\nSources :\n- Ciment Douala : https://exemple.org/ciment" }] } }] },
  ];
  const texte = await generateReply([{ role: "user", text: "Prix du ciment à Douala ?" }]);
  verifie("réponse finale rendue", texte.startsWith("Environ 5 000 FCFA."), texte);
  verifie("deux appels au modèle", appels.length === 2, String(appels.length));
  verifie("outils proposés au premier appel", JSON.stringify(appels[0].tools).includes("rechercher_web"));
  verifie("consigne avec la date et les sources", /Nous sommes le .*Sources :/s.test(appels[0].systemInstruction.parts[0].text));
  const second = JSON.stringify(appels[1].contents);
  verifie("demande du modèle renvoyée avec sa signature", second.includes("sig-1"));
  verifie("résultat de recherche renvoyé au modèle", second.includes("functionResponse") && second.includes("exemple.org/ciment"));

  // Un modèle qui cherche sans fin : au 5e appel, plus d'outil permis.
  appels.length = 0;
  const demande = { candidates: [{ content: { parts: [{ functionCall: { name: "rechercher_web", args: { requete: "encore" } } }] } }] };
  reponses = [demande, demande, demande, demande, { candidates: [{ content: { parts: [{ text: "Voilà ce que j'ai trouvé." }] } }] }];
  const borne = await generateReply([{ role: "user", text: "Cherche sans t'arrêter" }]);
  verifie("boucle bornée à 4 tours d'outils", appels.length === 5 && borne === "Voilà ce que j'ai trouvé.", `${appels.length} appels`);
  verifie("dernier appel sans outil", appels[4]?.toolConfig?.functionCallingConfig?.mode === "NONE");

  globalThis.fetch = vraiFetch;
} finally {
  // Fermer les connexions gardées ouvertes AVANT de rendre la main : sinon
  // Node s'arrête pendant la fermeture, et Windows le signale.
  serveur.closeAllConnections();
  await new Promise((r) => serveur.close(r));
}

console.log(ko === 0 ? `\n${ok} vérifications, toutes vertes.` : `\n${ko} échec(s) sur ${ok + ko}.`);
process.exitCode = ko === 0 ? 0 : 1;
