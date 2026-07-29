#!/bin/bash
# Applique tous les fichiers SQL de prisma/manual/ à la base configurée.
#
# Pourquoi ce script : ces fichiers ne sont joués ni par `npm run build`, ni par
# `prisma generate`, ni par `git pull`. L'étape s'oublie — elle a déjà coûté
# deux séances de diagnostic, la table Appareil ayant disparu à chaque
# recréation de la base.
#
# Tous les fichiers sont écrits en IF NOT EXISTS : les relancer est sans effet
# si l'objet existe déjà. Ce script peut donc être exécuté à chaque
# déploiement, systématiquement.
#
# Usage :
#   bash scripts/apply-manual-sql.sh
#
# La connexion est lue depuis DATABASE_URL dans .env — la même que
# l'application, ce qui évite d'appliquer les changements à la mauvaise base.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "ERREUR : .env introuvable. Lancer depuis la racine du projet." >&2
  exit 1
fi

URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d'"' -f2)"
if [ -z "$URL" ]; then
  echo "ERREUR : DATABASE_URL absent ou mal formé dans .env." >&2
  exit 1
fi

# Rappel visible de la cible : la confusion entre bases a déjà fait perdre du
# temps. Le mot de passe est masqué.
echo "Cible : $(echo "$URL" | sed -E 's|://([^:]+):[^@]*@|://\1:****@|')"
echo

compte=0
for fichier in prisma/manual/*.sql; do
  [ -e "$fichier" ] || continue
  echo "--- $fichier"
  psql "$URL" -v ON_ERROR_STOP=1 -f "$fichier"
  compte=$((compte + 1))
done

echo
echo "$compte fichier(s) appliqué(s)."
