#!/usr/bin/env bash
# Encode un fichier service account Firebase en base64 pour .env
# Usage : bash scripts/firebase-encode-sa.sh ~/Downloads/alanya-app-firebase-adminsdk.json
set -euo pipefail
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <fichier-service-account.json>"
  exit 1
fi
base64 -w0 "$1"
echo ""
