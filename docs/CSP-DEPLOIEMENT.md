# La politique de sécurité du contenu — ce qui reste à faire sur le serveur

> **Écrit pour qui déploie Alanya Web sur le VPS.** Établi le 24/09/2026,
> ticket 5.2 du plan de chiffrement.

---

## Ce qui est déjà fait, et ce qui ne l'est pas

La politique est posée **dans l'application**, par une balise `<meta>` injectée
à la construction (`vite.config.ts`). Elle part donc avec chaque déploiement,
sans rien à configurer.

**Mais trois directives sont ignorées dans une balise `<meta>`.** Le navigateur
les lit et les jette :

| directive | ce qu'elle protège | état |
|---|---|---|
| `frame-ancestors` | le détournement de clic — votre page affichée dans l'`<iframe>` d'un site hostile | ❌ **manquante** |
| `report-uri` / `report-to` | savoir qu'une violation s'est produite chez un vrai utilisateur | ❌ manquante |
| `sandbox` | non utilisée ici | — |

> 🔴 **`frame-ancestors` est celle qui compte.** Sans elle, un site hostile peut
> charger Alanya dans un cadre invisible et faire cliquer l'utilisateur sur ce
> qu'il veut — y compris, un jour, un bouton qui désactive une protection.

---

## L'en-tête à ajouter dans nginx

Dans le bloc qui sert `/webapp/` :

```nginx
# Le détournement de clic : personne n'a de raison légitime d'afficher
# Alanya dans un cadre.
add_header Content-Security-Policy "frame-ancestors 'none'" always;

# Ceinture et bretelles pour les navigateurs anciens, qui ignorent
# `frame-ancestors` mais comprennent cet en-tête-ci.
add_header X-Frame-Options "DENY" always;

# Le navigateur ne doit pas deviner le type d'un fichier : un `.txt` servi
# comme du JavaScript est une façon classique d'injecter du code.
add_header X-Content-Type-Options "nosniff" always;

# Les URL de nos pages ne partent pas chez les sites tiers qu'on visite ensuite.
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

⚠️ **`always` n'est pas facultatif.** Sans ce mot, nginx omet l'en-tête sur les
réponses d'erreur — c'est-à-dire précisément les pages qu'un attaquant cherche à
faire afficher.

⚠️ **NE PAS recopier ici la politique complète.** Deux politiques CSP se
**cumulent** en se restreignant mutuellement : la plus stricte des deux gagne,
directive par directive. Poser une seconde politique partielle dans l'en-tête
casserait l'application, parce que tout ce qui n'y figure pas retomberait sur
`default-src`. L'en-tête ne porte donc **que** `frame-ancestors`.

---

## Après le déploiement, vérifier

```bash
curl -sI https://alanyavox.com/webapp/ | grep -i "content-security\|x-frame"
```

Doit rendre les deux lignes. Puis, dans le navigateur, ouvrir la console sur
l'application : **aucune** ligne `Refused to …` ne doit apparaître en usage
normal.

---

## Ce que la politique autorise, et pourquoi

Ces trois lignes ont été trouvées **par le banc**, pas par raisonnement — et
chacune corrigeait un défaut qui serait parti en production.

| autorisation | sans elle |
|---|---|
| `'wasm-unsafe-eval'` | 🔴 **le chiffrement ne démarre pas.** Argon2id (`hash-wasm`) et Curve25519 sont des modules WebAssembly. Une CSP qui les bloque désactive le chiffrement qu'elle prétend protéger. |
| l'origine de `VITE_WS_URL` | 🔴 **plus rien n'arrive en temps réel.** L'adresse du WebSocket est une variable SÉPARÉE de celle de l'API ; la déduire de l'API donne une politique qui bloque la vraie connexion. Silencieux : l'application se charge, on lit ses messages, et les nouveaux n'arrivent jamais. |
| `www.gstatic.com` dans `script-src` | les notifications push cessent — le service worker de Firebase y charge son SDK. |

⚠️ **`'wasm-unsafe-eval'` n'est PAS `'unsafe-eval'`.** La seconde autoriserait
`eval()` sur du JavaScript, donc l'exécution de code arbitraire — exactement ce
que cette politique existe pour empêcher. La première n'ouvre que WebAssembly,
dont les modules sont livrés avec l'application.

---

## La limite qu'il faut connaître

`style-src` garde `'unsafe-inline'`. L'application pose **38 balises `<style>`
et 209 attributs `style`** — mesurés, pas supposés. Les remplacer par des
empreintes ou des nonces demanderait de réécrire toute la mise en forme.

Le risque résiduel est l'exfiltration par sélecteur CSS : réel, mais très
inférieur à l'exécution de code. C'est un arbitrage assumé, pas un oubli.
