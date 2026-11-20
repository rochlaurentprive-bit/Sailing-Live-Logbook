# Documentation par version

Chaque version a un dossier `docs/v<version>/<langue>/` (fr, nl, en, de, es), avec les mêmes noms de fichiers :

| Fichier | Contenu | Dans quel package |
|---|---|---|
| `1-Notes-de-version.pdf` | notes de version | Android et Raspberry Pi |
| `2-Manuel.pdf` | manuel de référence | Android et Raspberry Pi |
| `3-Deploiement-Android.pdf` | note de déploiement Android | Android |
| `3-Deploiement-RaspberryPi.pdf` | note de déploiement Pi | Raspberry Pi |
| `4-Note-detaillee-evolution.pdf` | quoi, comment, pourquoi, impacts | Android et Raspberry Pi |

Facultatif : `docs/v<version>/NOTES.md` = texte de la publication GitHub.

## Process pour chaque nouvelle version
1. Changer la version dans `package.json` (et `APP_VERSION` dans `www/index.html`).
2. Générer les documents dans la langue (ou les 5 langues) choisie, les déposer dans `docs/v<version>/<langue>/`.
3. Pousser, puis lancer **Actions > Publier les 2 packages** (ou pousser le tag `v<version>`).
4. Récupérer, dans l'onglet **Releases**, les deux fichiers :
   `Carnet-de-bord_Android_v<version>.zip` et `Carnet-de-bord_RaspberryPi_v<version>.zip`.

Le workflow compile l'APK, empaquette le plugin Pi, lance les tests (non-régression sans Pi + plugin + InfluxDB) et refuse de publier si l'un échoue ou si la documentation manque.
