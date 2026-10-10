# Chapitre 38 — Plus de limite au nombre de clés, et le disque plein

> **Où nous en sommes.** 10/10/2026. Décision du user : « je ne veux pas de
> limite de clé pour le moment ». Ce chapitre supprime les deux plafonds
> trouvés en mesurant, et raconte une panne de banc qui n'avait rien à voir
> avec le code.
>
> Backend `0027b20`, web `14fbb2c`, mobile `1dad06b`. Tout est déployé ; l'APK
> se reconstruit sur la CI.

---

## 1. Deux plafonds, trouvés en mesurant

On ne les avait pas **décidés** : ils découlaient de limites posées ailleurs.

| Où | Plafond | Conséquence |
|---|---|---|
| L'**enveloppe** qui transporte le trousseau (64 Ko côté serveur) | ~560 versions | au-delà, la distribution échoue : nouveaux membres et nouvelles versions n'arrivent plus |
| La **copie personnelle** (1 000 000 de caractères) | ~8 600 versions | au-delà, la sauvegarde pour un nouveau téléphone échoue |

Mesuré en construisant des trousseaux de 100 à 1 000 versions : 500 versions
font 57 Ko d'enveloppe, 600 en font 69.

> 🎓 **Leçon.** Une limite peut exister sans que personne l'ait décidée : elle
> **découle** d'une autre. Pour la trouver, on mesure la taille réelle de ce
> qui voyage, pas seulement le nombre d'éléments.

## 2. L'enveloppe : découper, pas agrandir

Agrandir le plafond de l'enveloppe aurait déplacé le problème — et affaibli
une garde du serveur contre l'abus. On **découpe** plutôt le trousseau :

- des morceaux de **400 versions** (~46 Ko d'enveloppe) ;
- chaque morceau est un **trousseau valide**, avec son groupe et son motif ;
- la réception les **fusionne** comme elle fusionnait déjà deux trousseaux
  (une version connue avec la même clé est ignorée, avec une autre est
  refusée).

Rien à changer côté serveur ni dans le format : la règle de fusion du
chapitre 32 suffisait.

## 3. La copie personnelle : relever la borne, pas la supprimer

La copie est **une** ligne en base par membre et par groupe. La borne passe
de 1 000 000 à **20 000 000** de caractères — environ **170 000 versions**,
c'est-à-dire des centaines d'années d'exclusions quotidiennes.

⚠️ **Une borne reste, volontairement.** Sans elle, un client malveillant
pourrait déposer une « copie » de plusieurs gigaoctets par groupe et remplir le
disque du serveur. Elle ne vise plus l'usage, seulement l'abus.

La migration (`prisma/manual/2026-10_e2ee_trousseaux_taille.sql`) est
**rejouable** : elle retire la contrainte si elle existe, puis la repose, sous
le **même nom** — le `CREATE TABLE IF NOT EXISTS` d'origine, rejoué avant elle
à chaque déploiement, ne la recrée donc pas. Éprouvée en local : dans une
transaction annulée, puis appliquée deux fois de suite, puis relue. Relue aussi
en production après le déploiement.

## 4. Les preuves

| Banc | Résultat |
|---|---|
| test mobile : 1 000 versions | 3 enveloppes, **toutes ≤ 64 Ko**, Bob reçoit les 1 000 |
| banc navigateur ⑧, contre le **vrai** serveur | la distribution passe sans échec, Bob reçoit les 1 000, sa copie les garde — 40 ✓ |
| suite mobile complète | 402 ✓ (avec les tests du collègue) |

## 5. La panne qui n'était pas dans le code : le disque plein (erreur ET solution)

La suite de tests mobile, qui prenait une minute, s'est **figée**. Pas d'échec,
pas d'erreur : elle s'arrêtait, chaque fois à un endroit différent.

La démarche :
1. le test où elle s'arrêtait **passait seul** ;
2. la suite **sans ma modification** se figeait aussi → ce n'était pas mon
   code ;
3. lancée fichier par fichier, elle se figeait au **chargement** d'un fichier,
   c'est-à-dire à sa compilation → c'était l'outil, pas un test ;
4. un outil qui se fige au hasard : on regarde les **ressources**. Le disque C
   avait **0 octet libre**.

Le remède : vider deux caches qui se reconstruisent seuls (fichiers
temporaires anciens, cache npm) — 1,9 Go libérés. La suite est repassée au
vert aussitôt.

Deux effets de bord le même jour, à ne pas confondre avec des défauts :
- les **polices Google** étaient injoignables depuis le réseau du poste : le
  banc navigateur attendait qu'elles se chargent. Il les coupe désormais —
  elles ne servent à rien pour un test ;
- le premier chargement de Vite, à froid, a dépassé le délai une fois.

> 🎓 **Leçon.** Quand un outil se fige sans erreur, à un endroit différent à
> chaque fois, le coupable n'est presque jamais le code : c'est la machine.
> Disque, mémoire, réseau — on regarde avant de relire.

## 6. À retenir

1. Une limite peut découler d'une autre : on **mesure** ce qui voyage.
2. Pour dépasser un plafond de transport, on **découpe** ; on n'affaiblit pas
   la garde.
3. Une borne contre l'**abus** n'est pas une limite d'**usage**.
4. Une migration rejouée à chaque déploiement doit être **idempotente**, et
   garder le **nom** de ce qu'elle remplace.
5. Un outil figé sans erreur : regarder le disque, la mémoire, le réseau.
