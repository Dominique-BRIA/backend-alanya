# Schéma Alanya — ce qu'on a repris de ton fichier, et ce qu'on n'a pas repris

**30 juillet 2026** · à propos de `schema.prisma` que tu nous as transmis

Salut,

On a comparé ton schéma au nôtre et aligné tout ce qui pouvait l'être. Voici où
on en est, et **trois questions** qui nous bloquent.

---

## Ce qu'on a repris

Tout le volet organisation : les 13 tables `ville`, `adminroot`, `company`,
`admin`, `agence`, `service`, `fonction`, `gestioncompany`, `centercom`,
`center`, `accesadmin`, `abonnement`, `prixabonnement`.

Les colonnes que tu ajoutais : `users.idcompany`, `users.appareil_total`,
`users.actif`, `users.mobile`, `pays.libelleAnglais`,
`callHistory.transmission`.

Les longueurs de colonnes : `pseudo` en 50, `alanyaPhone` en 20, `email` en 100,
`password` en 255, `pays.libelle` en 100, `avatar_url` en `TEXT`.

Les valeurs par défaut sur `pays` et `meeting`, et les noms de champs
(`center_alanyaID`, `date_at`, `acces_at`, les relations en majuscule…).

**C'est en production, ça tourne.**

---

## ⚠️ Trois choses qu'on pense être des oublis chez toi

Ce sont nos vraies questions. On n'a pas repris ces points, mais si c'est
volontaire, dis-le-nous et on s'aligne.

### 1. `alanyaPhone` n'a plus de contrainte d'unicité

Dans ton fichier, la colonne est déclarée sans `@unique`. **Deux comptes
pourraient alors avoir le même Alanya ID.** On a gardé l'unicité.

### 2. La colonne `expires_at` de `message` a disparu

C'est elle qui porte les **messages éphémères** (le minuteur 24 h / 7 j / 90 j).
La retirer désactive la fonctionnalité sans que rien ne le signale.

### 3. Les dates de `message` perdent le fuseau horaire

`sendAt`, `readAt` et `editedAt` passent de `Timestamptz` à `Timestamp`. Comme
on a des utilisateurs sur plusieurs fuseaux, l'ordre des messages deviendrait
faux dès qu'un téléphone et le serveur ne sont pas dans la même zone.

---

## Ce qu'on ne peut pas faire tout de suite

### La refonte de `message`

Tu passes sa clé primaire d'`UUID` à `BigInt`. Ça touche aussi les quatre tables
qui la référencent : `message_stars`, `message_reactions`, `message_hides`,
`media_files`.

Ce n'est pas un renommage : il faut une table de correspondance, reprendre
chaque table enfant, et couper le service. Côté code, ça représente environ
**340 références** à modifier dans l'API, le serveur temps réel et les trois
clients (mobile, web, backend).

On est d'accord sur le principe, mais **c'est un chantier à planifier**, pas un
lot courant. Quand tu veux qu'on en parle.

### Quatre petits points

| Ce que ton fichier propose | Pourquoi on ne l'a pas pris |
|---|---|
| `alanyaPhone` avec une valeur par défaut `"100000"` | Un défaut sur une colonne unique est un piège : le premier qui omet le champ obtient `100000`, le deuxième plante |
| `Meeting.idOrganiser` peut être vide | Une réunion sans organisateur ne veut rien dire |
| `MeetingParticipant.IDparticipant` peut être vide | Idem, un participant sans utilisateur |
| Retirer l'unicité sur `(idMeeting, IDparticipant)` | Le même utilisateur pourrait s'inscrire deux fois à une réunion |

Petite remarque au passage : l'index `@@index([idMeeting])` que tu ajoutes est
déjà couvert par la contrainte d'unicité existante. Il ferait double emploi.

---

## En résumé

**On a tout aligné sauf ce qui casse la production.** Il nous faut juste ta
réponse sur les trois points du milieu — surtout le premier, l'unicité de
l'Alanya ID, qui nous semble le plus important.

Merci !
