#!/usr/bin/env bash
# Assemble les deux packages de publication : Android et Raspberry Pi.
# Usage : scripts/package-release.sh <version> <fichier.apk> <fichier.tgz> <dossier-de-sortie>
set -euo pipefail
VER="$1"; APK="$2"; TGZ="$3"; OUT="$4"
DOCS="docs/v$VER"
[ -d "$DOCS" ] || { echo "Documentation absente : $DOCS (voir docs/README.md)"; exit 1; }
mkdir -p "$OUT"
build() {  # $1 = android|pi, $2 = nom du dossier, $3 = fichier principal
  local flavor="$1" name="$2" main="$3" dir="$OUT/$2"
  rm -rf "$dir"; mkdir -p "$dir/Documentation"
  cp "$main" "$dir/"
  for lang in "$DOCS"/*/; do
    l=$(basename "$lang"); mkdir -p "$dir/Documentation/$l"
    for f in "$lang"*.pdf; do
      b=$(basename "$f")
      case "$b" in
        3-Deploiement-Android*)      [ "$flavor" = android ] || continue ;;
        3-Deploiement-RaspberryPi*|5-Guide-Installation-RaspberryPi*)  [ "$flavor" = pi ] || continue ;;
      esac
      cp "$f" "$dir/Documentation/$l/"
    done
  done
  if [ "$flavor" = android ]; then
    cat > "$dir/LISEZ-MOI.txt" <<T
Carnet de bord - version $VER - Android
1. Ouvrez Documentation/<langue>/3-Deploiement-Android.pdf
2. Installez le fichier $(basename "$main") sur le telephone (par-dessus l'ancienne version).
3. Choisissez la source des donnees dans Reglages, puis suivez la recette du document.
Les autres documents : notes de version, manuel, note detaillee des evolutions.
T
  else
    cat > "$dir/LISEZ-MOI.txt" <<T
Carnet de bord - version $VER - Raspberry Pi (OpenPlotter / Signal K)
1. Ouvrez Documentation/<langue>/3-Deploiement-RaspberryPi.pdf
2. Copiez $(basename "$main") sur le Pi puis : cd ~/.signalk && npm install /chemin/$(basename "$main")
3. Redemarrez Signal K, activez le plugin, ouvrez la webapp, suivez la recette du document.
Le guide d'installation illustre (5-Guide-Installation-RaspberryPi.pdf) detaille chaque etape.
Les autres documents : notes de version, manuel, note detaillee des evolutions.
T
  fi
  (cd "$OUT" && zip -qr "$2.zip" "$name")
}
build android "Carnet-de-bord_Android_v$VER" "$APK"
build pi "Carnet-de-bord_RaspberryPi_v$VER" "$TGZ"
ls -la "$OUT"/*.zip
