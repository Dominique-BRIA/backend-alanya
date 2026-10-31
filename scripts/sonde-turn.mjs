// Sonde des relais TURN (31/10/2026) : STUN, allocation TURN authentifiée en
// UDP, ports TCP 3478, TLS 5349 et 443. À lancer sur le serveur, avec l'env
// de l'API chargé :  node scripts/sonde-turn.mjs
// Le secret n'est jamais affiché.
// Sonde TURN : STUN, allocation TURN authentifiée (UDP), ports TCP/TLS.
// Lancée sur le VPS : lit COTURN_SECRET / COTURN_DOMAINS dans l'environnement,
// n'affiche jamais le secret.
import dgram from "node:dgram";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

const secretDefini = !!process.env.COTURN_SECRET;
const secret = process.env.COTURN_SECRET || "alanya1960-Secure";
const domaines = (process.env.COTURN_DOMAINS || "alanya226.com,kemita.eu").split(",").map((d) => d.trim());
console.log(`COTURN_SECRET défini en production : ${secretDefini ? "oui" : "NON (valeur par défaut du dépôt)"}`);

const COOKIE = 0x2112a442;
function message(type, attrs, cle) {
  const tid = crypto.randomBytes(12);
  const corps = [];
  for (const [t, v] of attrs) {
    const pad = (4 - (v.length % 4)) % 4;
    const a = Buffer.alloc(4 + v.length + pad);
    a.writeUInt16BE(t, 0); a.writeUInt16BE(v.length, 2); v.copy(a, 4);
    corps.push(a);
  }
  let attributs = Buffer.concat(corps);
  const entete = (len) => { const h = Buffer.alloc(20); h.writeUInt16BE(type, 0); h.writeUInt16BE(len, 2); h.writeUInt32BE(COOKIE, 4); tid.copy(h, 8); return h; };
  if (cle) {
    const avant = Buffer.concat([entete(attributs.length + 24), attributs]);
    const mi = crypto.createHmac("sha1", cle).update(avant).digest();
    const a = Buffer.alloc(24); a.writeUInt16BE(0x0008, 0); a.writeUInt16BE(20, 2); mi.copy(a, 4);
    attributs = Buffer.concat([attributs, a]);
  }
  return Buffer.concat([entete(attributs.length), attributs]);
}
function lire(buf) {
  const type = buf.readUInt16BE(0); const len = buf.readUInt16BE(2);
  const attrs = {}; let i = 20;
  while (i < 20 + len) { const t = buf.readUInt16BE(i); const l = buf.readUInt16BE(i + 2); attrs[t] = buf.subarray(i + 4, i + 4 + l); i += 4 + l + ((4 - (l % 4)) % 4); }
  return { type, attrs };
}
// Une seule socket par serveur : coturn lie le nonce au couple adresse/port.
function udp(hote, port, msg, ms = 4000, s = null) {
  const propre = !s;
  s ??= dgram.createSocket("udp4");
  return new Promise((res) => {
    const fin = (v) => { clearTimeout(t); s.removeAllListeners("message"); if (propre) s.close(); res(v); };
    const t = setTimeout(() => fin(null), ms);
    s.once("message", (m) => fin(lire(m)));
    s.send(msg, port, hote);
  });
}
function tcp(hote, port, ms = 4000) {
  return new Promise((res) => { const s = net.connect({ host: hote, port }); const t = setTimeout(() => { s.destroy(); res(false); }, ms);
    s.on("connect", () => { clearTimeout(t); s.destroy(); res(true); }); s.on("error", () => { clearTimeout(t); res(false); }); });
}
function tlsOk(hote, port, ms = 5000) {
  return new Promise((res) => { const s = tls.connect({ host: hote, port, servername: hote }); const t = setTimeout(() => { s.destroy(); res("délai dépassé"); }, ms);
    s.on("secureConnect", () => { clearTimeout(t); const c = s.getPeerCertificate(); s.destroy(); res(`ok (certificat valide jusqu'au ${c.valid_to}, ${s.authorized ? "reconnu" : "NON reconnu"})`); });
    s.on("error", (e) => { clearTimeout(t); res(`échec : ${e.code || e.message}`); }); });
}

for (const d of domaines) {
  console.log(`\n=== ${d}`);
  const stun = await udp(d, 3478, message(0x0001, []));
  console.log(`STUN UDP 3478 : ${stun && stun.type === 0x0101 ? "ok" : "pas de réponse"}`);

  const transport = Buffer.from([17, 0, 0, 0]);
  const sock = dgram.createSocket("udp4");
  const r1 = await udp(d, 3478, message(0x0003, [[0x0019, transport]]), 4000, sock);
  if (!r1) { console.log("TURN UDP : pas de réponse"); }
  else {
    const realm = r1.attrs[0x0014]?.toString(); const nonce = r1.attrs[0x0015];
    if (!realm || !nonce) console.log(`TURN UDP : réponse inattendue (type 0x${r1.type.toString(16)})`);
    else {
      const user = `${Math.floor(Date.now() / 1000) + 600}:sonde`;
      const mdp = crypto.createHmac("sha1", secret).update(user).digest("base64");
      const cle = crypto.createHash("md5").update(`${user}:${realm}:${mdp}`).digest();
      const r2 = await udp(d, 3478, message(0x0003, [[0x0006, Buffer.from(user)], [0x0014, Buffer.from(realm)], [0x0015, nonce], [0x0019, transport]], cle), 4000, sock);
      if (r2?.type === 0x0103) console.log(`TURN UDP : ALLOCATION OK (realm ${realm})`);
      else if (r2?.type === 0x0113) { const e = r2.attrs[0x0009]; console.log(`TURN UDP : refus ${e ? e[2] * 100 + e[3] : "?"} ${e ? e.subarray(4).toString() : ""} (realm ${realm})`); }
      else console.log("TURN UDP : pas de réponse à la requête authentifiée");
    }
  }
  sock.close();
  console.log(`TCP 3478 : ${(await tcp(d, 3478)) ? "ouvert" : "fermé"}`);
  console.log(`TLS 5349 : ${await tlsOk(d, 5349)}`);
  console.log(`TLS 443 : ${await tlsOk(d, 443)}`);
}
