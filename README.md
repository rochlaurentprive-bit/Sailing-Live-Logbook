# Carnet de bord — appli Android

Appli Android (lecture directe du YDWG-02, enregistrement des trajets, météo Windy, routage).
Tu n'as rien à installer sur ton ordinateur : GitHub compile l'APK pour toi.

## 1. Compiler l'APK avec GitHub (une fois, ~10 minutes)

1. Crée un compte gratuit sur https://github.com puis clique sur **New repository**.
   Nom : `carnet-de-bord`, laisse-le **Private**, clique **Create repository**.
2. Sur la page du dépôt, clique **uploading an existing file** et glisse **tout le contenu de ce dossier**
   (dossiers `www`, `native`, `scripts` et les fichiers `package.json`, `capacitor.config.json`, `README.md`).
   Clique **Commit changes**.
3. Le dossier caché `.github` ne se glisse pas toujours : clique **Add file → Create new file**,
   tape exactement `.github/workflows/build-apk.yml` comme nom, colle le contenu du fichier
   `build-apk.yml` fourni, puis **Commit changes**.
4. Ouvre l'onglet **Actions**. Une compilation « Compiler l'APK » démarre toute seule (5 à 10 minutes).
   Si rien ne démarre : clique sur le workflow puis **Run workflow**.
5. Quand elle est verte ✅, ouvre-la et télécharge **carnet-de-bord-apk** en bas de page (un .zip contenant `app-debug.apk`).
6. Si elle est rouge ❌ : copie le message d'erreur du dernier pas qui a échoué et envoie-le moi.

## 2. Installer sur le téléphone

1. Envoie `app-debug.apk` sur ton téléphone (e-mail, Drive, câble USB).
2. Ouvre-le. Android demande d'autoriser « l'installation d'applications inconnues » pour l'appli qui l'ouvre : accepte.
3. Au premier lancement, autorise les **notifications** (nécessaires pour que l'enregistrement continue écran éteint).

## 3. Se connecter au YDWG-02

1. Dans les réglages Wi-Fi du téléphone, connecte-toi au réseau du YDWG-02.
   Android dit « Pas d'accès à Internet » : choisis **Rester connecté**.
2. Dans l'appli : ⚙️ **Réglages** → Source de données = **YDWG-02 direct (appli Android)**.
3. Adresse = `192.168.4.1` et port = `1456` (valeurs usuelles du YDWG-02 : vérifie-les dans sa page de
   configuration si tu les as changées), puis **Enregistrer**.
4. Le voyant en haut passe à **YDWG-02** en vert quand les données arrivent.

## 4. Windy
Dans ⚙️ Réglages, colle tes clés Windy (Point Forecast et Map Forecast). Le téléphone utilise ses données mobiles
pour Windy et les cartes, pendant que le Wi-Fi du bateau sert aux instruments.

## Ce qui change par rapport à la web app
- Lecture directe du YDWG-02 (TCP), sans Raspberry ni Signal K.
- Service au premier plan + notification : l'enregistrement des trajets continue écran éteint.
- Exports GPX / CSV / sauvegarde via le menu Partager d'Android.
- Pas d'impression PDF pour l'instant (utilise le CSV ou le GPX).

## Limites connues (version de départ, non testée sur un bateau)
- Messages NMEA 2000 décodés : position, COG/SOG, vent, vitesse surface, profondeur, cap, moteur (régime, température,
  pression d'huile), tension et charge des batteries. D'autres se rajoutent facilement.
- Cette version a été écrite sans pouvoir être compilée ni essayée sur un vrai YDWG-02 : prévois un premier essai à quai.
