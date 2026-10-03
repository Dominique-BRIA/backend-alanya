# Courrier sortant : Postmark ET Bird

**3 octobre 2026** · remplace la partie « qui envoie » de `2026-09-11-postmark.md`.

---

## Qui envoie quoi

| Courriel | Déclenché par | Route | Fournisseur |
|---|---|---|---|
| Code de **création de compte** | inscription, web + mobile | `POST /api/auth/register` | **Postmark** |
| Code de **mot de passe oublié** | web + mobile | `POST /api/auth/forgot-password` | **Postmark** |
| Code de **création d'un compte agent** | plateforme de l'équipe | `POST /api/v1/verifications` (`CREATION_AGENT`) | **Postmark** |
| Code de **nouvelle adresse e-mail** | Réglages → Récupération, web + mobile | `POST /api/account/email` | **Bird** |
| Code de **double authentification** | plateforme de l'équipe | `POST /api/v1/verifications` (`AUTH_2FA`) | **Bird** |
| Code de **confirmation d'adresse** | plateforme de l'équipe | `POST /api/v1/verifications` (`VALIDATION_CONTACT`) | **Bird** |

Le partage vit dans `VOIE_DU_MOTIF` (`src/lib/courriel.mjs`) et nulle part ailleurs.

- **Le contenu est écrit dans le code**, pas chez les fournisseurs
  (`src/lib/courriel-contenu.mjs`) : un texte par motif, dans les **neuf langues**.
  La langue vient de l'en-tête `Accept-Language`, que le web et le mobile posent
  avec la langue choisie dans l'application ; l'API v1 accepte aussi un champ
  `langue`. Rien n'est stocké chez Postmark ni chez Bird.
- **Expéditeur** : `Alanya Work <info@alanya.cloud>` — `alanya.cloud` est vérifié
  chez les deux fournisseurs.
- **Postmark** : serveur dédié **AlanyaWork** (pas le serveur « Alanya » du grand
  public). Étiquettes `work-inscription`, `work-mot-de-passe`, `work-creation-agent`.
- **Bird** : API e-mail régionale (`https://eu1.platform.bird.com/v1/email/messages`,
  région déduite de la clé `bk_eu1_…`), catégorie `transactional`, aucun suivi des
  liens. Étiquette `motif` = `work-changement-adresse`, `work-double-auth`,
  `work-validation-contact`.

Contrôles hors ligne : `node src/lib/courriel.mjs` et `node src/lib/courriel-contenu.mjs`.

---

## `MAIL_PROVIDER`

| Valeur | Effet |
|---|---|
| `auto` ou absent | Chaque courriel par **son** fournisseur si sa clé est posée, sinon SMTP. |
| `postmark` | Postmark pour **tout** (secours si Bird est en panne). |
| `bird` | Bird pour **tout** (secours si Postmark est en panne). |
| `smtp` | L'ancien relais Gmail seul — **retour arrière**. |

⚠️ En `auto`, une clé manquante retombe sur SMTP, **jamais** sur l'autre fournisseur.

---

## Mise en service

### 1. `.env` du VPS (`~/backend-alanya/.env`)

```
MAIL_PROVIDER=auto
POSTMARK_SERVER_TOKEN=<jeton du serveur Postmark AlanyaWork>
POSTMARK_FROM=Alanya Work <info@alanya.cloud>
BIRD_API_KEY=<clé bk_eu1_… de Bird>
BIRD_FROM=Alanya Work <info@alanya.cloud>
```

Les clés ne vont **jamais** dans le dépôt. Une ancienne ligne `POSTMARK_FROM` en
`@alanyavox.com` doit être remplacée : ce domaine n'est vérifié ni chez Postmark ni
chez Bird.

### 2. Déployer et redémarrer

`./deployer.sh` (le `.env` n'est relu qu'au redémarrage des processus).

### 3. Vérifier

- Créer un compte de test → le courriel arrive ; il apparaît dans Postmark,
  serveur **AlanyaWork** → Activity, étiquette `work-inscription`.
- Réglages → Récupération → ajouter une adresse → le courriel arrive ; il apparaît
  dans Bird → Email → Messages.
- `pm2 logs alanya-api | grep mailer` : `work-… envoyé par Postmark|Bird à …`.
  Le code n'est jamais écrit dans les journaux.

Vérifié le 03/10/2026 avant mise en service : un envoi par chaque voie, depuis
`info@alanya.cloud`, vers les adresses de test des fournisseurs — Postmark accepté
(`7e14933b…`), Bird remis (`em_01m41k21…`).

---

## À surveiller

- **Bird était bridé** (« throttled ») le 03/10/2026 : 7 % de rebonds sur 7 jours
  pour une limite de 0,6 %. Les envois peuvent être retardés tant que ce taux ne
  baisse pas. Le compte Bird est partagé : ces rebonds ne viennent pas d'Alanya Work.
- Erreurs Bird lisibles dans les journaux : `401 InvalidAPIKey` (clé fausse ou
  d'une autre région), `422 ValidationError` (expéditeur hors d'un domaine vérifié).
- Erreurs Postmark : voir `2026-09-11-postmark.md`, § « Messages d'erreur à connaître ».
