# Portage iOS (en cours, branche `feature/ios-boatlink`)

Principe : le noyau (`www/index.html`) est inchangé ; seul le plugin natif `BoatLink` est réécrit en Swift.

| Fichier | Rôle |
|---|---|
| `BoatLinkPlugin.swift` | Équivalent de `native/java/BoatLinkPlugin.java` : TCP vers le YDWG-02 (Wi-Fi forcé), vibration (Core Haptics), écran allumé, notifications, maintien en vie par la localisation |
| `MainViewController.swift` | Enregistre le plugin (plugin local, hors npm) |
| `../../scripts/patch-ios.js` | Après `npx cap add ios` : copie les fichiers, patche storyboard et Info.plist (réseau local, http/ws en clair, localisation en arrière-plan) |
| `../../scripts/add-ios-files.rb` | Ajoute les fichiers Swift à la cible Xcode |
| `../../.github/workflows/build-ios.yml` | Compilation simulateur sur macOS (sans signature) |

## Reste à faire / à vérifier sur un vrai iPhone
- Le workflow n'a pas encore été exécuté : première compilation à corriger si besoin.
- Lecture du YDWG-02 écran verrouillé : dépend du mode « Localisation » en arrière-plan (indicateur bleu visible).
- Permission « Réseau local » : acceptée à la première connexion.
- Le texte « appli Android requise » (`startYdwg`) est à rendre générique (noyau, non modifié ici).
- Signature, TestFlight et App Store : compte Apple Developer nécessaire.
