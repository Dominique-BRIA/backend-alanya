/**
 * LE BANC DES DROITS DE GROUPE (01/11/2026) — les règles pures de
 * `src/lib/groupe-droits.mjs`, sans serveur ni base.
 *
 *   ① qui est admin, avec le repli « premier membre » d'un groupe sans admin ;
 *   ② le propriétaire effectif : désigné ET encore membre ;
 *   ③ la sourdine : pour toujours, pour un temps, « mentions seulement ».
 *
 * Usage : node scripts/groupe-droits-banc.mjs
 */
import assert from "node:assert/strict";
import {
  enSourdinePour,
  estAdminDuGroupe,
  proprietaireEffectif,
} from "../src/lib/groupe-droits.mjs";

let n = 0;
function cas(nom, f) {
  f();
  n += 1;
  console.log(`  ✓ ${nom}`);
}

console.log("① administrateurs");
cas("un ADMIN est admin, un MEMBER non", () => {
  const ps = [
    { userId: "a", role: "ADMIN" },
    { userId: "b", role: "MEMBER" },
  ];
  assert.equal(estAdminDuGroupe(ps, "a"), true);
  assert.equal(estAdminDuGroupe(ps, "b"), false);
});
cas("sans aucun admin, le premier membre en fait office", () => {
  const ps = [
    { userId: "a", role: "MEMBER" },
    { userId: "b", role: "MEMBER" },
  ];
  assert.equal(estAdminDuGroupe(ps, "a"), true);
  assert.equal(estAdminDuGroupe(ps, "b"), false);
});
cas("un admin parti n'est plus admin, et ne bloque pas le repli", () => {
  const ps = [
    { userId: "a", role: "ADMIN", estMembre: false },
    { userId: "b", role: "MEMBER" },
  ];
  assert.equal(estAdminDuGroupe(ps, "a"), false);
  assert.equal(estAdminDuGroupe(ps, "b"), true);
});
cas("un non-membre n'est rien", () => {
  assert.equal(estAdminDuGroupe([{ userId: "a", role: "ADMIN" }], "z"), false);
});

console.log("② propriétaire");
cas("désigné et membre : c'est lui", () => {
  assert.equal(proprietaireEffectif({ proprietaireId: "a" }, [{ userId: "a" }]), "a");
});
cas("désigné mais parti : personne", () => {
  assert.equal(
    proprietaireEffectif({ proprietaireId: "a" }, [{ userId: "a", estMembre: false }]),
    null,
  );
});
cas("groupe d'avant, sans désignation : personne", () => {
  assert.equal(proprietaireEffectif({ proprietaireId: null }, [{ userId: "a" }]), null);
});

console.log("③ sourdine");
const maintenant = new Date("2026-11-01T12:00:00Z");
const ctx = (mentionne, enGroupe = true) => ({ mentionne, enGroupe, maintenant });
cas("pour toujours : même une mention ne passe pas", () => {
  assert.equal(enSourdinePour({ sourdine: 1 }, ctx(true)), true);
});
cas("pour un temps : jusqu'à l'heure dite, pas après", () => {
  const p = { sourdine: 0, sourdineJusqua: new Date("2026-11-01T20:00:00Z") };
  assert.equal(enSourdinePour(p, ctx(false)), true);
  assert.equal(
    enSourdinePour(p, { ...ctx(false), maintenant: new Date("2026-11-01T21:00:00Z") }),
    false,
  );
});
cas("mentions seulement : la mention passe, le reste non", () => {
  const p = { sourdine: 0, mentionsSeulement: true };
  assert.equal(enSourdinePour(p, ctx(false)), true);
  assert.equal(enSourdinePour(p, ctx(true)), false);
});
cas("mentions seulement n'a pas de sens à deux : ignoré", () => {
  assert.equal(enSourdinePour({ sourdine: 0, mentionsSeulement: true }, ctx(false, false)), false);
});
cas("aucun réglage : notifié", () => {
  assert.equal(enSourdinePour({ sourdine: 0 }, ctx(false)), false);
});

console.log(`\n${n} cas, tous passés.`);
