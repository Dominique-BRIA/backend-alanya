# Chapitre 35 — Administrer un groupe chiffré, et retrouver ses clés

> **Où nous en sommes.** 10/10/2026. Les applications savaient lire et écrire
> dans un groupe chiffré (chapitre 34), mais la clé devait être distribuée
> « à la main ». Ce chapitre couvre :
>
> - le **lot 5** : activer, ajouter, exclure, changer la clé ;
> - le **lot 6** : la copie personnelle du trousseau, et le nouveau téléphone.
>
> Web : `src/services/e2ee-groupe-admin.ts`, `src/services/e2ee-trousseau-perso.ts`,
> banc `scripts/e2ee-groupe-admin-web.mjs`. Mobile : `GroupeChiffre`
> (`e2ee_groupe_fil.dart`), `e2ee_trousseau_perso.dart`, test
> `test/e2ee_trousseau_perso_test.dart`. Aucun changement serveur : tout
> existait depuis le lot 2.

---

## 1. Les quatre gestes d'administrateur

| Geste | Le serveur | L'appareil de l'administrateur |
|---|---|---|
| **Activer** | réserve la version 1 | tire la clé, la distribue à **chaque appareil de chaque membre** |
| **Ajouter** | ajoute (refuse sans clés) | envoie **tout** le trousseau au nouveau → il lit l'historique |
| **Exclure** | marque le départ, efface la copie de l'exclu | réserve la version n + 1, la distribue aux **restants** |
| **Changer la clé** | réserve la version n + 1 | idem, motif MANUEL |

Le serveur ne voit jamais une clé : il **numérote**, l'appareil **tire** et
**distribue**.

## 2. Le piège de l'ordre : réserver d'abord, tirer ensuite

Deux administrateurs activent au même instant. Si chacun **tire sa clé
d'abord** puis demande la version 1 :

1. Alice tire K, Bob tire K' ;
2. le serveur donne la version 1 à Alice, refuse Bob ;
3. Bob a gardé K' sous le numéro 1 ;
4. la vraie clé 1 (K) arrive chez Bob → **refusée** : « version déjà connue
   avec une autre clé » (règle du chapitre 31, qui protège contre un faux
   trousseau) ;
5. Bob ne lit plus rien du groupe.

La règle de sécurité se retourne contre nous. La parade est simple : **on ne
range la clé qu'après la réservation**. Refusé, on n'a rien tiré.

> 🎓 **Leçon.** Une règle de sécurité stricte (« ne jamais remplacer une
> clé ») rend l'**ordre** des opérations critique. Ce qui n'est pas encore
> acquis ne doit pas être écrit.

## 3. Distribuer à 300 personnes

- Une enveloppe Signal **par appareil** : 300 membres à deux appareils, 600
  enveloppes. D'où le plafond du serveur porté à 1 000 au lot 2, et des dépôts
  découpés par 1 000.
- **Mes autres appareils aussi** : mon navigateur doit recevoir la clé que
  mon téléphone vient de tirer.
- **Un membre injoignable n'arrête pas les autres** : il est compté
  (`sansAppareil`, `echecs`), et le reste du groupe reçoit sa clé.

## 4. Le nouveau membre lit l'historique

Décision du user : contrairement à WhatsApp, un membre ajouté voit les
messages d'avant son arrivée. Il reçoit donc **tout le trousseau** (toutes les
versions), et le chiffré de chaque ancien message est toujours sur le serveur.

## 5. Un défaut trouvé par le banc : « Dave a la clé, mais ne lit rien »

Dave vient d'être ajouté. Sa relève reçoit le trousseau, il le range… et ses
bulles restent vides.

**La cause** : son navigateur ne savait pas encore que ce fil était chiffré.
Il n'avait pas rechargé la liste des conversations, qui porte `e2eeActif`. Le
fil ne tentait donc aucun déchiffrement.

**La solution**, sur le web comme sur le téléphone :
- recevoir la clé d'un groupe, **c'est** savoir qu'il est chiffré ;
- un message qui arrive avec son chiffré de groupe est toujours ouvert, sans
  attendre l'état.

> 🎓 **Leçon.** Un état local (« ce fil est chiffré ») qui arrive par un autre
> chemin que la donnée elle-même finit toujours par être en retard sur elle.
> Quand la donnée se suffit, on se fie à la donnée.

## 6. Lot 6 : la copie personnelle

### Ce qu'elle est

Une copie de **mon** trousseau pour **ce** groupe, déposée sur le serveur,
chiffrée par la **clé maîtresse de mon archive personnelle** — celle qui
s'ouvre avec le mot de passe (décision du user : rien d'autre à retenir).

```
corps = base64( 0x01 | nonce 12 | AES-256-GCM(trousseau) )
données associées = "alanya-trousseau-perso-v1\n<mon compte>\n<groupe>"
```

- Le serveur ne peut pas la lire.
- Les **données associées** la lient à mon compte et à ce groupe : servie à
  la place d'une autre, elle est refusée avant même d'être lue.
- Le clair est la charge « trousseau » ordinaire : mêmes contrôles qu'une
  clé reçue d'un autre appareil.

### Quand elle est déposée

**À chaque changement** du trousseau local (activation, réception, nouvelle
version). Une version reçue et pas recopiée serait perdue au changement de
téléphone.

### Quand elle est relue

1. **Au démarrage / à la connexion** : toutes mes copies sont reprises d'un
   coup.
2. **À la demande** : dès qu'un message demande une version absente, la copie
   est relue (une tentative par demi-minute et par groupe, pour ne pas faire
   une requête par bulle).

### Le format est commun au web et au téléphone

Un vecteur produit par WebCrypto (comme le navigateur) est **ouvert** par le
téléphone, et **réécrit à l'octet près** avec le même nonce. Une copie déposée
par le navigateur s'ouvre donc sur le téléphone du même compte, et l'inverse.

## 7. Les preuves

| Banc | Où | Résultat |
|---|---|---|
| `e2ee-groupe-admin-web.mjs` | vrai Chrome, 4 comptes + un **second navigateur** de Bob | 29 ✓ |
| `e2ee_trousseau_perso_test.dart` | vraie bibliothèque Signal, vecteur WebCrypto | 10 ✓ |
| suite mobile complète | — | 393 ✓ |

Le banc navigateur active **par le bouton de l'écran**, vérifie que le bouton
est inerte pour un membre, ajoute Dave (qui lit l'historique), exclut Carole
(version 2 pour les autres, Carole oublie la clé), change la clé à la main, et
connecte Bob sur un **navigateur neuf** : il reprend les trois versions depuis
sa copie et relit tout.

### Une fausse alerte de ma part (erreur ET solution)

J'ai cru à un échec **intermittent** : je comptais les « ✓ » d'un passage
(20, puis 29) et je les comparais au total que je **croyais** juste (21, puis
30). Il manquait toujours « un » contrôle… qui n'avait jamais existé. Une
boucle de passages, avec le journal complet gardé, a tranché : chaque passage
affichait « TOUT EST VERT » avec 20 et 29 contrôles.

> 🎓 **Leçon.** Un chiffre comparé à un autre chiffre n'est une preuve que si
> le second est sûr. Le banc dit lui-même s'il est vert : c'est cette ligne-là
> qu'il faut lire, pas un décompte refait à la main.

## 8. Ce qui reste fragile, et c'est assumé

- **Réserver puis ne pas distribuer** (navigateur fermé entre les deux) :
  personne n'a la nouvelle version, les envois attendent. Remède : « Changer
  la clé », par n'importe quel administrateur.
- **Un appareil sans archive ouverte** ne dépose pas de copie : un autre de
  mes appareils la déposera à sa prochaine réception.
- **Le repli « un autre de mes appareils renvoie la clé »** (motif APPAREIL)
  n'est pas fait : la copie personnelle couvre le cas, tant que l'archive
  est active.

## 9. À retenir

1. Le serveur **numérote**, l'appareil **tire** et **distribue**.
2. On ne range une clé qu'**après** que le serveur a accordé son numéro.
3. Un membre injoignable n'arrête jamais la distribution aux autres.
4. Recevoir une clé de groupe, c'est savoir que le groupe est chiffré.
5. La copie personnelle suit **chaque** changement, et se relit **à la
   demande** : c'est elle qui fait le nouveau téléphone.
