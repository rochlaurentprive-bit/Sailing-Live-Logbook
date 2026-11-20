# Carnet de bord pour Raspberry Pi (OpenPlotter / Signal K)

Deuxième version de l'application, **à côté** de la version Android (qui reste inchangée et se construit toujours par `.github/workflows/build.yml`). Les deux partagent le même cœur (`www/index.html`).

## Ce que fait la version Pi
- Sert l'appli depuis Signal K : `http://openplotter.local:3000/signalk-carnet-de-bord/` (adresse à adapter).
- Le **plugin « Carnet de bord »** enregistre les trajets **24 h/24**, même sans téléphone connecté (mêmes règles que l'appli : départ au-dessus de 1,5 nd pendant 30 s, un point toutes les 10 s, entrée de journal toutes les 15 min, arrêt après 5 min sous 0,5 nd). Les seuils se règlent dans le plugin.
- Trajets, notes, photos et journal d'audit sont rangés **sur le Pi** et partagés entre tous les appareils. Waypoints, route, polaire, checklists, entretien et favoris AIS aussi.
- Les données viennent de Signal K : bus NMEA2000 (interface CAN ou passerelle USB) et capteurs Bluetooth, via leurs plugins Signal K.

## Installation (sur le Pi)
1. Récupérer `signalk-carnet-de-bord-<version>.tgz` (artefact « carnet-de-bord-raspberry-pi » de GitHub Actions, ou `cd pi && node scripts/build.js && npm pack`).
2. Sur le Pi : `cd ~/.signalk && npm install /chemin/signalk-carnet-de-bord-<version>.tgz`
3. Redémarrer Signal K (`sudo systemctl restart signalk` sous OpenPlotter).
4. Signal K → *Server → Plugin Config* → « Carnet de bord » : vérifier qu'il est activé.
5. Ouvrir la webapp depuis le menu *Webapps* de Signal K. À la première ouverture, la source de données est réglée sur ce Signal K.

Si la sécurité Signal K est activée, se connecter à Signal K dans le navigateur avant d'ouvrir l'appli.

## Données et sauvegarde
- Tout est dans le dossier de données du plugin (`~/.signalk/plugin-config-data/carnet-de-bord/data/`).
- Sauvegarde complète en un fichier : `http://<pi>:3000/plugins/carnet-de-bord/backup`.
- Écriture atomique : une coupure de courant ne tronque aucun fichier ; un trajet en cours est repris au redémarrage s'il date de moins de 15 min.

## Développement
- `node scripts/build.js` : copie `www/index.html` + adaptateur `public/pi-adapter.js` (ne modifie pas `www/`).
- `node test/run.js` : tests du collecteur, de l'enregistreur et de l'API.
- `NODE_PATH=$(npm root -g) node test/browser.js` : tests navigateur (version Pi branchée sur le plugin + non-régression de la version sans Pi).
- Les crochets de la version commune sont repérables par `window.PIBOX` dans `www/index.html` ; ils sont inactifs sans l'adaptateur (Android).

## Historique InfluxDB (lecture seule, facultatif)

Dans la configuration du plugin, section « Historique InfluxDB » : version (1.x InfluxQL / 2.x Flux), adresse, base ou bucket, identifiants.
Le plugin **lit uniquement** InfluxDB (jamais d'écriture ni de suppression). Réglages de l'appli → « Reconstruire les trajets depuis InfluxDB » :
les trajets sont reconstruits avec les mêmes règles que l'enregistreur (départ 1,5 nd / 30 s, arrêt 0,5 nd / 5 min), sans doublon avec les trajets existants.
API : `GET /influx/status`, `GET /influx/probe`, `POST /influx/import {from,to}` (62 jours max par appel).

## Règle de compatibilité (obligatoire)

Toute évolution du noyau `www/index.html` doit fonctionner **sans Raspberry et sans Signal K** : les fonctions propres au Pi vivent
uniquement derrière `window.PIBOX` (défini par `pi-adapter.js`, absent sur Android). `test/regression.js` (workflow `regression.yml`) le vérifie à chaque push.
