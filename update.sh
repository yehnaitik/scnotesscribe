#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
echo ""
echo " Shadowcore Studyink — Updating..."
echo " Downloading latest version from GitHub..."
echo ""

curl -fsSL "https://raw.githubusercontent.com/yehnaitik/scnotesscribe/main/shadowcore-studyink-v2.zip" -o "$DIR/_update_tmp.zip"
if [ $? -ne 0 ]; then
  echo " ERROR: Download failed. Check internet connection."
  exit 1
fi

unzip -o "$DIR/_update_tmp.zip" -d "$DIR" > /dev/null
rm "$DIR/_update_tmp.zip"
echo " Done!"
echo ""
echo " Now:"
echo "  1. Open Chrome and go to: chrome://extensions"
echo "  2. Find 'Shadowcore Studyink'"
echo "  3. Click the Reload (refresh) icon on it"
echo ""
