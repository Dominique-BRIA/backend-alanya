# Chapitre 37 — Le repli « appareil », et un défaut qui n'en était pas un

> **Où nous en sommes.** 10/10/2026. Tous les lots du chiffrement des groupes
> sont faits (chapitres 31 à 36). Ce chapitre ferme les deux points restés
> ouverts :
>
> - le **repli « appareil »** : mes autres appareils me renvoient une clé de
>   groupe qui me manque ;
> - le « défaut de l'aperçu PDF », qui était un **banc périmé**.
>
> Web `3434ca6` et `3e38f59`, mobile `1215c49`. Aucun changement serveur.

---

## 1. Le cas que la copie personnelle ne couvre pas

La copie personnelle du trousseau (chapitre 35) est chiffrée par la clé de
l'**archive**. Elle ne sert donc que si l'archive est **ouverte** sur
l'appareil. Elle ne sert pas :

- sur un appareil où l'archive n'a jamais été ouverte (refusée, mot de passe
  pas encore saisi) ;
- quand la copie est **en retard** (une version reçue par un appareil dont
  l'archive était fermée, donc jamais recopiée).

Or si j'ai **un autre appareil** qui a la clé, il peut me la donner.

## 2. Le principe

1. Il me manque une clé (ou une version) : je relis d'abord ma copie.
2. Si elle n'aide pas, j'envoie une **demande** à **mes autres appareils** :
   une enveloppe Signal ordinaire, hors fil, avec un préfixe à elle
   (`\u0000GD`).
3. Celui qui a la clé me renvoie **tout le trousseau** (motif `APPAREIL`).
4. La sonnette `e2ee_trousseau` (chapitre 36) me fait relever : la bulle
   « en attente de la clé » se remplit.

Aucun changement côté serveur : il transporte une enveloppe de plus, sans la
comprendre.

## 3. La règle de sécurité : seul MON compte peut demander

Un appareil qui reçoit une demande vérifie qui l'a envoyée. L'expéditeur est
**sûr** : c'est sa session Signal qui a déchiffré la demande.

| Demande venue de… | Réponse |
|---|---|
| un autre appareil de **mon** compte | ✅ je renvoie le trousseau |
| un **autre** compte (même membre du groupe) | ❌ refusée, rien ne part |

⚠️ **La limite assumée** : un appareil que le serveur glisserait dans **mon**
compte passerait — mais il recevrait déjà tout ce que j'écris. C'est la même
limite qu'au chapitre 31, et la même parade : comparer le code de sécurité.

## 4. Ne pas inonder

- **Une demande par groupe et par minute** : un fil plein de bulles « en
  attente » ne doit pas envoyer une demande par bulle.
- **Une réponse par groupe et par demi-minute** : si deux de mes appareils
  demandent ensemble, un seul envoi suffit.
- Deux de mes appareils peuvent répondre à la même demande : sans danger, la
  fusion du trousseau ignore une version déjà connue avec la même clé.

## 5. Les preuves

| Banc | Scénario | Résultat |
|---|---|---|
| `e2ee-groupe-admin-web.mjs` ⑦ | la copie de Bob est **supprimée** ; un 3ᵉ navigateur de Bob, sans clé ni copie, ouvre le fil | il reçoit les 4 versions de ses autres navigateurs et relit l'historique — 37 ✓ au total |
| `e2ee_trousseau_perso_test.dart` | un second téléphone de Bob **sans archive** | il reçoit la clé de son premier téléphone et lit |
| `e2ee_trousseau_perso_test.dart` | Carole envoie une demande au téléphone de Bob | **aucun** envoi de Bob — suite mobile : 398 ✓ |

Un piège de test, au passage : la demande part **en tâche de fond**. Le test
faisait répondre le premier téléphone avant que la demande soit déposée. Il
attend désormais son dépôt — le code, lui, était juste.

## 6. Le « défaut de l'aperçu PDF » (erreur ET solution)

Depuis le lot 4, le banc `e2ee-media-envoi` échouait sur « … et sa première
page en aperçu ». Je l'avais signalé comme un **défaut ancien**, sans rapport
avec les groupes, parce que l'échec était le même sans mes changements.

En le regardant enfin : le banc cherchait la classe `.mc-doc-apercu`. Le
07/10, le commit `98db89c` (« documents chiffrés en grand ») l'avait renommée
`.mc-doc-page`. L'aperçu était **fabriqué, transmis et affiché** depuis le
début ; c'est le **banc** qui regardait au mauvais endroit.

> 🎓 **Leçon.** « Le même échec sans mes changements » prouve que ce n'est pas
> **mon** changement. Ça ne prouve pas que c'est un défaut de l'application :
> le banc lui-même peut être périmé. Avant de signaler un défaut, on regarde
> ce que le contrôle **cherche**.

C'est la deuxième fois en deux jours (après « Transférer » au chapitre 34) :
un banc qui n'a pas suivi un changement d'interface.

## 7. À retenir

1. La copie personnelle couvre l'appareil **avec** archive ; le repli
   « appareil » couvre celui **sans**.
2. Seul **mon** compte peut me demander une clé.
3. Toute demande automatique a son **délai de repos**.
4. Un banc qui échoue peut être **périmé** : lire ce qu'il cherche avant
   d'accuser l'application.
