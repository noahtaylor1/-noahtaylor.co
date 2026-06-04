#!/bin/bash
# Deploy noahtaylor.co → GitHub Pages
set -e

cd "$(dirname "$0")"

MSG=${1:-"Update site"}

git add -A
git commit -m "$MSG"
git push origin main

echo "✓ Deployed: $MSG"
