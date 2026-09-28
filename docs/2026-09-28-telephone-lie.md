# `users` : une colonne ajoutée, une colonne mise en service

Salut,

Petit point sur la table `users`, pour que ton schéma et le nôtre restent
d'accord.

## Ce qui change

Un compte ne s'ouvre plus que sur **un seul téléphone**. Se connecter depuis un
deuxième téléphone est **refusé** tant que l'utilisateur n'a pas appuyé sur
« Dissocier ce téléphone » depuis le premier. Le web n'est pas concerné.

| Colonne | Avant | Maintenant |
|---|---|---|
| `device_ID` | existait chez toi, vide partout, lue par personne | l'identifiant du téléphone lié ; vide = aucun téléphone lié |
| `dissocier` | n'existait pas | **ajoutée** : `boolean NOT NULL DEFAULT true` ; vrai = aucun téléphone lié |

## ⚠️ Ce qu'il faut savoir si ta plateforme y touche

Les deux colonnes disent la même chose, et **la base refuse qu'elles se
contredisent** (contrainte `users_dissocier_coherent`) :

- lier un téléphone = `device_ID = '<identifiant>'` **et** `dissocier = false`,
  dans le même `UPDATE` ;
- libérer un compte = `device_ID = NULL` **et** `dissocier = true`, dans le même
  `UPDATE`.

Écrire l'une sans l'autre échoue avec une erreur de contrainte. C'est voulu :
un compte « lié à personne » ou « libre mais lié » serait accepté ou refusé
selon le champ lu.

Si ton back-office doit un jour libérer un compte (téléphone perdu, par
exemple), c'est le second `UPDATE` ci-dessus — mais préviens-nous d'abord : il
faut aussi couper la session du téléphone, ce que la colonne seule ne fait pas.

Migration : `prisma/manual/2026-09_telephone_lie.sql`.

Merci !
