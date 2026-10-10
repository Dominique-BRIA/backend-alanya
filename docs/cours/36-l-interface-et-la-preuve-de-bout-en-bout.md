# Chapitre 36 — L'interface du groupe chiffré, et la preuve de bout en bout

> **Où nous en sommes.** 10/10/2026. Les lots 5 et 6 donnaient aux
> administrateurs de quoi gérer la clé, et à chacun de quoi la retrouver
> (chapitre 35). Ce chapitre couvre :
>
> - le **lot 7** : ce que l'écran montre — avis, attente de la clé,
>   vérification d'un membre ;
> - le **lot 8** : la preuve que le **téléphone** et le **navigateur** se
>   comprennent, par le vrai serveur, et le plan de déploiement.
>
> Commits : backend `f700b14`, web `bd77348` et `405004f`, mobile `8d68541` et
> `e2df0ee`.

---

## 1. Les avis système

Deux nouveaux avis, déposés par le serveur dans le fil :

| Code | Phrase | Quand |
|---|---|---|
| `e2ee_active` | « X a activé le chiffrement de bout en bout » | une fois, par l'administrateur qui a gagné la course |
| `e2ee_cle_changee` | « X a changé la clé du groupe » | changement **manuel** seulement |

Après une **exclusion**, pas d'avis de clé : « X a été retiré par Y » dit déjà
tout, et un second avis ferait croire à deux événements.

⚠️ **Un client plus ancien** ne connaît pas ces codes : il n'affiche **rien**,
jamais le JSON brut. C'était déjà la règle des avis : c'est ce qui rend le
déploiement du serveur sans risque.

## 2. « En attente de la clé du groupe »

Avant, un message dont la clé manquait affichait « indisponible sur cet
appareil » — comme un message perdu. Or c'est un état **passager** : la clé
arrive (nouvelle version tout juste créée, membre tout juste ajouté).

Désormais :
- la bulle dit **« Message chiffré — en attente de la clé du groupe »** ;
- quand la clé arrive, **la bulle se remplit d'elle-même**, sans recharger.

### La sonnette qui manquait

Pour que la bulle se remplisse, il faut savoir que la clé est arrivée. Or le
trousseau voyage **hors fil**, et le serveur ne sonnait pas pour un dépôt hors
fil (règle anti-harcèlement du chapitre 26).

Nouvelle sonnette **`e2ee_trousseau`**, seulement pour un trousseau **dans un
groupe** : des identifiants, **pas de notification** (on ne fait pas vibrer un
téléphone pour une clé). L'appareil relève ; le fil ouvert se rouvre.

> 🎓 **Leçon.** Chaque fois qu'une donnée change d'état ailleurs, il faut se
> demander : **qui le saura, et comment ?** Sans réponse, l'écran reste figé
> jusqu'à ce qu'on le rouvre.

## 3. Vérifier un membre

Le risque majeur d'un groupe chiffré (chapitre 31) : un serveur malveillant
**ajoute un appareil** au compte d'un membre, et reçoit les clés.

La parade est la même qu'à deux : **comparer le code de sécurité** avec la
personne, hors de l'application. La fiche du groupe propose donc, pour chaque
membre d'un groupe chiffré, **« Vérifier le code de sécurité »** — le même écran
qu'en tête-à-tête.

## 4. Le lot 8 : le téléphone et le navigateur, ensemble

Jusqu'ici, chaque client était prouvé **seul** (ou avec un faux serveur). Il
restait à prouver qu'ils se comprennent **en vrai**.

### Le montage

```
scripts/e2ee-groupe-mobile-web.mjs (Node)
 ├─ lance le vrai Chrome  ──────── Wes, client web
 └─ lance `flutter test`  ──────── Mia, le VRAI code Dart de l'application
                                    (coffre, service, fil, GroupeChiffre)
             tous deux → le vrai serveur local (API + WebSocket)
```

Le test Dart écrit des lignes `BANC: …` au fil de l'eau ; le script les lit et
pilote le navigateur en conséquence.

⚠️ **Tout le scénario mobile tient dans un seul test** : le stockage sécurisé
du banc vit en mémoire le temps du processus. Deux lancements successifs
seraient deux téléphones différents.

### Ce qui est prouvé (17 contrôles)

1. **Le mobile active** le groupe ; la clé arrive dans le navigateur.
2. **Le web lit le mobile** — dans l'écran du fil, avec l'avis d'activation ;
   le serveur n'a qu'un chiffré, aucun texte.
3. **Le mobile lit le web.**
4. **Le mobile change la clé** ; la version 2 arrive dans le navigateur, et le
   message suivant, en version 2, s'y lit.

Vert **du premier coup** : c'est le fruit des vecteurs croisés des lots 1 et 6,
qui avaient déjà aligné les formats octet par octet.

## 5. Le déploiement : pourquoi il doit être coordonné

| Pièce | Sans risque seule ? | Pourquoi |
|---|---|---|
| **Serveur** | ✅ oui | les nouveaux avis sont muets chez les anciens clients ; la sonnette ne vise que les groupes chiffrés, qui n'existent pas encore |
| **Web** | ❌ non | il permet à un administrateur d'**activer** un groupe… dont les membres sur téléphone, avec l'ancienne application, ne pourraient ni lire ni écrire |
| **Téléphone (APK)** | ✅ oui | il sait lire et écrire, mais personne ne peut encore activer depuis le web |

D'où l'ordre :

1. le **serveur** (fait) ;
2. l'**APK**, et laisser le temps aux téléphones de se mettre à jour ;
3. le **web** en dernier — c'est lui qui ouvre la fonctionnalité.

> 🎓 **Leçon.** Déployer, ce n'est pas « mettre en ligne ce qui est prêt ».
> C'est se demander, pour chaque pièce, **ce qu'elle permet aux autres de
> faire** — et ouvrir la porte en dernier.

## 6. Ce qui reste

- Le **repli « un autre de mes appareils renvoie la clé »** (motif APPAREIL) :
  non fait, la copie personnelle couvre le cas tant que l'archive est active.
- Le défaut **antérieur** de l'aperçu de la première page d'un PDF (banc
  `e2ee-media-envoi`), sans lien avec les groupes.

## 7. À retenir

1. Un avis inconnu reste **muet** chez un vieux client : c'est ce qui rend le
   serveur déployable seul.
2. « En attente » n'est pas « perdu » : l'écran doit le **dire**, et se
   **remplir seul** quand la clé arrive.
3. Toute donnée qui change ailleurs a besoin de sa **sonnette**.
4. La vérification d'un membre est la seule parade contre un appareil glissé
   par le serveur.
5. La preuve de bout en bout se fait avec **les deux vrais clients** et **le
   vrai serveur**.
6. On **ouvre la porte en dernier** : serveur, puis APK, puis web.
