# Le chiffrement d'Alanya — ce que nous voyons, et ce que nous ne voyons pas

> **Écrit pour l'équipe produit, le support et la rédaction de la politique de
> confidentialité.** 24/09/2026, lot 6 du plan de chiffrement.
>
> 🔴 Ce document existe parce qu'une fonctionnalité de chiffrement peut être
> **vraie dans le code et fausse pour l'utilisateur**. Tout ce qui suit est
> vérifié dans la base et dans le code, pas supposé.

---

## 1. Ce que nous ne pouvons pas lire

| | |
|---|---|
| le texte des messages chiffrés | `message.content` est **vide** |
| les enveloppes (`e2ee_enveloppes.corps`) | chiffré, et **indéchiffrable même par nous** |
| l'archive (`e2ee_archive_blocs.contenu`) | chiffré par une clé que nous n'avons pas |

C'est une impossibilité mathématique, pas une promesse : le serveur ne détient
aucune clé permettant d'ouvrir quoi que ce soit.

---

## 2. 🔴 Ce que nous voyons quand même

**Le chiffrement ne cache pas les métadonnées.** Laisser croire le contraire est
le plus grand risque de cette fonctionnalité — bien avant un défaut technique.

| nous voyons | nous ne voyons pas |
|---|---|
| **qui parle à qui**, et depuis quels appareils | ce qui est dit |
| **quand**, à la seconde près | |
| la **taille** de chaque message | |
| le **nombre** de messages par bloc d'archive | |
| quelles conversations sont chiffrées | |

> Un observateur qui a la base sait qu'Alice a écrit onze fois à Bob entre 22 h
> et 23 h, avec des messages de plus en plus courts. Il ne sait pas un mot de ce
> qu'ils se sont dit.

**Ce qu'il faut écrire dans la politique de confidentialité** : nous conservons
les métadonnées de communication (participants, horodatage, volume) même pour
les conversations chiffrées, et nous ne pouvons pas ne pas les conserver — elles
sont ce qui permet d'acheminer un message.

---

## 3. ⚠️ Les conversations ordinaires ne sont PAS chiffrées

Le chiffrement est activé **par conversation**. Au 24/09/2026, sur la base de
développement : **17 chiffrées, 138 ordinaires**.

Pour ces 138, `message.content` contient le texte **en clair**.

Ce n'est pas un défaut : c'est la conception. Les centres d'appels, les comptes
API et les groupes en sont exclus par construction, parce que ces conversations
doivent rester lisibles par l'organisation.

> **La politique de confidentialité doit distinguer les deux.** Dire « vos
> messages sont chiffrés de bout en bout » sans préciser *lesquels* serait faux
> pour la grande majorité des conversations.

---

## 4. ⚠️ La limite de la serrure « mot de passe »

La sauvegarde chiffrée s'ouvre par trois serrures. L'une d'elles dérive du mot
de passe du compte.

**Or notre serveur reçoit ce mot de passe en clair à chaque connexion** — c'est
ainsi que fonctionne l'authentification, et il a été décidé de ne pas la
réécrire (23/09/2026).

Conséquence, à écrire noir sur blanc :

> Cette serrure protège votre sauvegarde **au repos**, contre le vol d'une copie
> de la base. Elle ne la protège **pas** contre un serveur Alanya compromis, qui
> pourrait dériver la même clé.
>
> **La clé de récupération et le trousseau de l'appareil n'ont pas cette
> limite** : ces secrets ne nous traversent jamais.

⚠️ Cette mention a été **retirée de l'écran des réglages** (décision du user,
23/09/2026) au profit de la politique de confidentialité. Tant qu'elle n'y est
pas écrite, **elle n'est écrite nulle part**.

---

## 5. Ce que le support doit savoir répondre

### « J'ai perdu mon mot de passe ET ma clé de récupération »

**La réponse est : nous ne pouvons rien faire. Et c'est voulu.**

Il n'existe aucune procédure interne, aucun accès administrateur, aucune
sauvegarde de secours. Si les trois serrures sont perdues, l'archive est des
octets que personne ne rouvrira jamais.

> ⚠️ **Cette réponse doit être donnée sans détour et sans faux espoir.** Laisser
> croire qu'une escalade est possible fait perdre du temps à tout le monde et
> transforme une limite assumée en promesse trahie.

Ce qu'on peut faire, en revanche :

1. vérifier si une **autre serrure** existe encore (le trousseau d'un appareil
   encore en service ouvre l'archive sans mot de passe) ;
2. rappeler que les messages **déjà sur l'appareil** ne sont pas perdus — c'est
   l'archive qui l'est ;
3. proposer de repartir d'une archive neuve, en notant cette fois la clé de
   récupération.

### « Mon correspondant a un avertissement de changement de clé »

C'est normal après une réinstallation ou un changement d'appareil. C'est **aussi**
ce qu'on verrait en cas d'interposition — les deux sont indistinguables.

La bonne réponse : comparer le **code de sécurité** de vive voix, hors de
l'application.

### « Je me suis déconnecté et mes messages ont disparu »

Si la sauvegarde était active, ils reviennent tout seuls à la reconnexion. Si
elle avait été désactivée, ils sont perdus — l'écran avertit avant la
déconnexion, précisément pour cela.

---

## 6. Ce qui reste vrai après ce document

| risque | assumé ? |
|---|---|
| la bibliothèque Signal du web n'est plus maintenue (3 ans) | 🔴 **non** — ticket 5.1 |
| le cache local garde les messages **en clair** sur l'appareil | 🟠 oui, décision du 21/09 |
| la serrure « mot de passe » n'oppose rien à un serveur compromis | 🟠 oui, à écrire (§4) |
| les métadonnées sont visibles | 🟡 oui, à écrire (§2) |
