# Chiffrement des groupes, version 2 — conception

> **Statut.** Validée par le user le 11/11/2026 (« oui vas-y »). Remplace la
> distribution de clés de `2026-10-08-e2ee-groupes-conception.md` ; le format
> des messages, les versions de clé et le périmètre restent ceux de ce
> document sauf mention contraire.
>
> **Objectif fixé par le user.** Pas un bout en bout strict : un chiffrement
> réel, en misant d'abord sur le confort. Inspiré de la « Spécification
> technique finale — chiffrement de groupe avec archive variable configurable
> et coffre-fort Argon2id » qu'il a fournie, sans la copier.

---

## 1. Ce qui ne va pas aujourd'hui

| Symptôme | Cause |
|---|---|
| « En attente de la clé du groupe » sur un téléphone neuf, une réinstallation, un nouveau navigateur | La clé est envoyée **appareil par appareil**, aux seuls appareils connus au moment de l'envoi. Les autres dépendent d'un administrateur ou d'un autre de leurs appareils **en ligne**. |
| « Clé du groupe pas encore reçue : le message n'est pas parti » | Sans clé, l'application refuse d'envoyer, et le serveur refuse le clair dans un groupe chiffré. |
| Groupe devenu illisible du jour au lendemain | Activation **automatique et silencieuse** par l'administrateur, définitive, même si des membres n'ont pas suivi. |
| Ouverture lente d'un groupe, aperçus lents | Chaque page est **redéchiffrée et sa signature revérifiée** à chaque ouverture, même ce qui est déjà lu, en Dart pur. |
| Messages « indisponibles » après la réinstallation d'un membre | Signature par **appareil**, vérifiée avec une identité déjà connue : un appareil neuf est inconnu. |
| Un membre qui a perdu la clé reste bloqué | Seuls les **administrateurs** peuvent la renvoyer. |

**La cause de fond : la clé dépend des appareils.** La version 2 la rattache au **compte**.

---

## 2. Les principes

1. **Une clé par compte, pas par appareil.** Chaque compte a une paire de clés
   Curve25519. Sa partie privée est rangée sur le serveur, chiffrée par la
   **clé maîtresse** de l'archive personnelle (Argon2id sur le mot de passe,
   existante). Le serveur la garde sans pouvoir l'ouvrir.
2. **La clé du groupe est emballée pour chaque membre, une fois par version, en base.**
   Un emballage ne se consomme pas : il reste, et tout appareil du membre le
   relit quand il veut.
3. **Un nouvel appareil n'a besoin de personne.** Tout le monde se connecte
   avec un mot de passe (confirmé par le user le 11/11/2026) : la connexion
   ouvre déjà la clé maîtresse, donc la clé du compte, donc tous les groupes.
4. **Tout membre qui a la clé peut emballer pour un autre membre**, selon le
   réglage d'historique du groupe. Plus personne n'attend un administrateur.
5. **Le confort d'abord** : envoi jamais bloqué, rien de redéchiffré deux fois,
   changement de clé en arrière-plan, aucune activation surprise.

---

## 3. Cryptographie

### 3.1 La clé du compte

- Paire **Curve25519** tirée sur l'appareil à la première connexion qui n'en
  trouve pas (aléa sûr de la plateforme). Format de la bibliothèque Signal :
  publique **33 octets** (préfixe `0x05`), privée 32 octets.
- **Publique** : publiée sur le serveur, liée au compte.
- **Privée** : la copie de trousseau personnelle existante (`chiffrerCopie` :
  `0x01 | nonce | AES-256-GCM`) appliquée à la privée en base64, sous la clé
  maîtresse, AAD `"alanya-compte-v1
" userId "
" version`, déposée sur le serveur. Copie
  locale dans le stockage sécurisé de l'appareil (Keystore / Keychain ;
  IndexedDB non extractible sur le web), comme la clé maîtresse aujourd'hui.
- **Versionnée** (`version` = 1, 2…) : elle ne change que si la clé maîtresse
  est perdue (§ 6.3).

> **La clé maîtresse devient obligatoire.** Elle protège désormais les clés,
> pas seulement l'archive des messages. Refuser la *sauvegarde des messages*
> reste possible ; la clé maîtresse existe quand même.

### 3.2 L'emballage de groupe

```
corps = base64( 0x01 | éphémère_pub(33) | nonce(12) | AES-256-GCM(K, clé_de_groupe_v 32) + étiquette(16) )
K     = HKDF-SHA256( X25519(éphémère_priv, compte_pub_destinataire),
                     sel = 32 zéros, info = "alanya-emballage-v1" )
AAD   = "alanya-emballage-v1
" convId "
" destinataireId "
" version "
" versionCompte
```

Implémentation de référence : `e2ee_groupe.dart` (mobile, `emballerCle` /
`deballerCle`), vecteurs figés dans `test/e2ee_groupe_v2_test.dart` — le web
(lot 4) doit produire les mêmes octets.

C'est le scellement que nous utilisons déjà pour les boîtes (`scellerBoite`),
adressé au **compte** au lieu de l'appareil. L'AAD colle l'emballage à son
groupe, son destinataire et sa version : le serveur ne peut pas le déplacer.

### 3.3 Le message de groupe, format 2

```
corps = base64( 0x02 | nonce(12) | AES-256-GCM(clé_de_groupe_v, charge) )
AAD   = "alanya-groupe-v2
" convId "
" messageId "
" version "
" expediteurId
```

L'appareil reste transmis au serveur (`groupe.appareil`) mais ne fait pas
partie des données associées.

> **Écrit seulement à partir du lot 5.** Tant qu'un membre peut avoir une
> application qui ne lit que le format 1, on écrit le format 1
> (`GroupeChiffre.ecrireFormat2 = false`) ; la lecture des deux formats est
> active dès le lot 3.

- **Plus de signature par appareil.** C'est le serveur qui garantit
  l'expéditeur (il refuse un message dont l'auteur n'est pas l'appelant), et
  l'AAD le colle au chiffré. Prix assumé : un membre **de connivence avec le
  serveur** pourrait écrire au nom d'un autre. Gain : plus jamais de message
  « indisponible » parce qu'un appareil est inconnu.
- **Les messages au format 1 (signés) restent lisibles** : on vérifie la
  signature si l'identité est connue ; sinon, on accepte un déchiffrement GCM
  réussi (l'AAD contrôle déjà groupe, message, version et expéditeur).

On ne reprend **pas** AES-CBC (aucune détection d'altération) ni RSA-2048 :
AES-GCM et Curve25519 sont déjà en place.

---

## 4. Le réglage d'historique

Le réglage existe déjà : `conversation.historique_cache_nouveaux` (01/11/2026),
appliqué jusqu'ici par le seul serveur (`historique_depuis` filtre les messages).
La version 2 le rend **cryptographique** :

| Réglage | À l'arrivée d'un membre |
|---|---|
| Historique **visible** (défaut) | L'appareil de celui qui ajoute emballe **toutes** les versions pour le nouveau venu. |
| Historique **caché** | L'appareil de celui qui ajoute crée la version **n + 1**, l'emballe pour **tous** les membres ; le nouveau venu ne reçoit **que** n + 1. Le filtre du serveur reste, en plus. |

> **Correction de la spécification fournie.** Elle écrit que « le serveur
> calcule rétroactivement les enveloppes ». Impossible ici : le serveur n'a
> jamais les clés. C'est l'appareil de celui qui ajoute — en ligne à cet
> instant — qui le fait ; s'il n'a pas encore les clés, le **rattrapage**
> (§ 5.6) s'en charge.

---

## 5. Les parcours

### 5.1 Connexion (tout appareil)
1. Le mot de passe ouvre la clé maîtresse (existant).
2. L'appareil lit la clé du compte (`GET /api/e2ee/compte`) et l'ouvre ; s'il
   n'y en a pas, il la crée et la dépose (§ 3.1).
3. Il relit ses emballages (`GET /api/e2ee/emballages`) : tous ses groupes sont
   lisibles, sans personne en ligne.

### 5.2 Activation d'un groupe
- **Plus d'activation surprise.** Automatique seulement si **tous** les membres
  ont une clé de compte publiée ; sinon le groupe reste en clair, et
  l'activation se refait à l'ouverture suivante.
- L'appareil qui active tire v1 et dépose un emballage par membre.

### 5.3 Envoyer
- Chiffrer avec la version courante (§ 3.3).
- **Jamais bloqué.** Clé absente, ou `VERSION_PERIMEE` : le message attend sur
  l'appareil (bulle « en attente », comme sans réseau) et part tout seul dès
  que la clé arrive, rechiffré si besoin.

### 5.4 Recevoir
- **D'abord le cache local** : un message déjà déchiffré ne l'est plus jamais.
- Déchiffrement **à la page affichée**, au défilement.

### 5.5 Ajouter un membre
Selon le réglage (§ 4), par l'appareil de celui qui ajoute. Refusé si le
nouveau venu n'a pas de clé de compte publiée : impossible en pratique, elle se
crée à sa première connexion.

### 5.6 Rattrapage des emballages manquants
À l'ouverture d'un groupe, un appareil qui a les clés demande au serveur les
emballages **manquants** (`GET /api/conversations/:id/e2ee/manquants`, calculé
d'après les membres, leurs clés de compte, les versions et le réglage
d'historique) et les dépose. Couvre : ajout fait depuis un appareil sans clés,
nouvelle clé de compte d'un membre (§ 6.3), migration (§ 7).

### 5.7 Départ et exclusion
- Départ : `est_membre = false`, ses emballages supprimés par le serveur.
- Exclusion : pareil, **plus** une version n + 1 créée **en arrière-plan** par
  l'appareil de l'administrateur, emballée pour les membres restants. Aucune
  approbation, aucune attente : les envois en cours repartent tout seuls (§ 5.3).

### 5.8 Changement manuel de clé
Comme l'exclusion, sans exclusion.

---

## 6. Cas particuliers

### 6.1 Biométrie
Inchangée : le verrou biométrique existant protège l'accès à l'application ;
les clés restent dans le stockage sécurisé de l'appareil.

### 6.2 Changement de mot de passe
La serrure `motdepasse` de la clé maîtresse est reposée (existant). La clé
maîtresse ne change pas : la clé du compte non plus.

### 6.3 Mot de passe oublié **et** clé de récupération perdue
La clé maîtresse est perdue, donc la clé du compte. L'appareil en crée une
version 2. Le **rattrapage** (§ 5.6) des autres membres réemballe pour elle :
- la version courante, toujours ;
- les versions passées si l'historique est visible.
**L'historique des groupes revient donc par les autres membres** — ce que la
version 1 ne permettait pas.

---

## 7. Migration (invisible)

Le premier appareil qui ouvre un groupe chiffré **en ayant ses clés** dépose
les emballages de tous les membres (rattrapage, § 5.6). Aucun geste de
personne. Un groupe dont **plus aucun** appareil n'a les clés reste illisible
pour son passé ; ses messages futurs repartent sur une nouvelle version.

Les boîtes par appareil, les enveloppes Signal de trousseau et les demandes
« à mes appareils » restent **lues** pendant la transition, puis sont retirées
(lot 6).

---

## 8. Base de données (migrations additives)

| Table | Colonnes | Rôle |
|---|---|---|
| `e2ee_cles_compte` | `alanyaID` PK, `version`, `publique`, `privee_chiffree`, `cree_le` | la clé du compte (§ 3.1) |
| `e2ee_emballages` | `conv_id`, `alanyaID`, `version`, `version_compte`, `corps`, `depose_par`, `depose_le` ; PK (`conv_id`, `alanyaID`, `version`, `version_compte`) | une clé de groupe, pour un membre (§ 3.2) |

- Un emballage déjà présent n'est **pas** remplacé par un autre dépôt (premier
  arrivé) ; le destinataire signale un emballage illisible, qui est alors
  retiré et redemandé au rattrapage.
- Supprimés au départ ou à l'exclusion du membre ; en cascade avec le groupe.

## 9. Routes

| Route | Rôle |
|---|---|
| `GET /api/e2ee/compte` / `PUT` | ma clé de compte (publique + privée chiffrée) |
| `GET /api/e2ee/cles-compte?ids=` | les clés **publiques** des membres (pour emballer) |
| `GET /api/e2ee/emballages[?convId=]` | mes emballages |
| `PUT /api/e2ee/emballages` | déposer : l'appelant doit être **membre actif** et avoir la version (il en a déposé ou reçu l'emballage, ou l'a créée) ; destinataires **membres actifs** ; versions passées refusées pour un membre arrivé alors que l'historique est caché |
| `GET /api/conversations/:id/e2ee/manquants` | ce qu'il reste à emballer (§ 5.6) |
| `POST /api/conversations/:id/e2ee/versions` | inchangé (rotation) |

Trames temps réel (porte « personnes », verbe `e2ee_*`) :
`e2ee_emballage { convId, version }` au destinataire ; `e2ee_manquants { convId }`
aux membres qui ont les clés, quand quelqu'un arrive ou change de clé de compte.

---

## 10. Garanties

| | v1 | v2 |
|---|---|---|
| Le serveur ne lit ni les messages ni les clés | ✅ | ✅ |
| Un nouvel appareil lit tout sans personne en ligne | ❌ | ✅ |
| Un membre sans clé peut quand même écrire | ❌ | ✅ (le message attend la clé) |
| Un exclu ne lit rien de nouveau | ✅ | ✅ |
| Un nouveau membre ne lit pas le passé quand l'historique est caché | ⚠️ filtre du serveur seulement | ✅ cryptographique |
| Un membre ne peut pas écrire au nom d'un autre | ✅ (signature) | ⚠️ garanti par le serveur |
| Historique retrouvé après perte du mot de passe et de la clé de récupération | ❌ | ✅ par les autres membres (historique visible) |

---

## 11. Les lots

| Lot | Contenu | Où | Validation |
|---|---|---|---|
| **1. Confort immédiat** | Cache d'abord (plus aucun redéchiffrement de ce qui est lu) ; envois en attente au lieu d'échouer (clé absente, `VERSION_PERIMEE`) ; plus d'activation automatique des groupes | mobile, web | analyse, tests, `tsc` |
| **2. Serveur v2** | Tables `e2ee_cles_compte`, `e2ee_emballages` ; routes § 9 ; trames ; suppression au départ ; envoi : expéditeur contrôlé, format 2 accepté | serveur | `tsc`, migration rejouable, bancs de routes |
| **3. Mobile v2** | Clé de compte (création, dépôt, ouverture à la connexion) ; lecture des emballages ; format 2 (écriture) et lecture des formats 1 et 2 ; emballage à l'activation, à l'ajout selon le réglage, à la rotation ; rattrapage | mobile | tests de vecteurs, analyse |
| **4. Web v2** | Le jumeau du lot 3 | web | vecteurs croisés web ↔ mobile, `tsc` |
| **5. Migration et activation** | Rattrapage des groupes existants ; activation automatique quand tous les membres ont une clé de compte ; rotation à l'arrivée quand l'historique est caché | mobile, web, serveur | bancs à plusieurs comptes et appareils |
| **6. Nettoyage** | Retrait des boîtes par appareil, des trousseaux par enveloppe Signal et des demandes à mes appareils (après la transition) | tous | — |
| **7. Bout en bout et livraison** | Parcours § 5 et § 6 sur de vrais téléphones et navigateurs ; déploiement serveur, web, APK | tous | essais réels avec le user |
