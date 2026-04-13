@echo off
title Shadowcore Studyink — Auto Update
echo.
echo  Shadowcore Studyink — Updating...
echo  Downloading latest version from GitHub...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/yehnaitik/scnotesscribe/main/shadowcore-studyink-v2.zip' -OutFile '%~dp0_update_tmp.zip' -UseBasicParsing; Write-Host ' Downloaded.' } catch { Write-Host ' ERROR: Could not download. Check internet.' ; pause ; exit 1 }"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Expand-Archive -Path '%~dp0_update_tmp.zip' -DestinationPath '%~dp0' -Force; Remove-Item '%~dp0_update_tmp.zip'; Write-Host ' Extracted.' } catch { Write-Host ' ERROR: Could not extract zip.' ; pause ; exit 1 }"

echo.
echo  Done! Now:
echo   1. Open Chrome and go to:  chrome://extensions
echo   2. Find "Shadowcore Studyink"
echo   3. Click the Reload (refresh) icon on it
echo.
pause
