// Exécuté après « npx cap add android » : ajoute le plugin natif, les permissions, le service et l'icône.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appDir = path.join(root, 'android', 'app', 'src', 'main');
const javaDir = path.join(appDir, 'java', 'com', 'carnetdebord', 'app');

// 1) fichiers Java (remplace MainActivity, ajoute le plugin et le service)
fs.mkdirSync(javaDir, { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'native', 'java'))) {
  fs.copyFileSync(path.join(root, 'native', 'java', f), path.join(javaDir, f));
  console.log('copié', f);
}

// 2) AndroidManifest : permissions, service au premier plan, trafic http/ws local autorisé
const manifestPath = path.join(appDir, 'AndroidManifest.xml');
let m = fs.readFileSync(manifestPath, 'utf8');
const perms = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.CHANGE_NETWORK_STATE',
  'android.permission.CHANGE_WIFI_STATE',
  'android.permission.WAKE_LOCK',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.ACCESS_FINE_LOCATION',   // GPS du téléphone
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.VIBRATE',   // retour haptique
  'android.permission.CAMERA',   // photos du carnet de bord
];
const missing = perms.filter((p) => !m.includes(`"${p}"`));
if (missing.length) {
  const block = missing.map((p) => `    <uses-permission android:name="${p}" />`).join('\n') + '\n';
  m = m.replace(/(\s*)<\/manifest>/, `\n${block}$1</manifest>`);
}
if (!m.includes('android.hardware.camera')) {
  m = m.replace(/(\s*)<\/manifest>/, '\n    <uses-feature android:name="android.hardware.camera" android:required="false" />$1</manifest>');
}
if (!m.includes('usesCleartextTraffic')) {
  m = m.replace('<application', '<application android:usesCleartextTraffic="true"');
}
if (!m.includes('.BoatService')) {
  m = m.replace('</application>', '    <service android:name=".BoatService" android:exported="false" android:foregroundServiceType="connectedDevice" />\n    </application>');
}
fs.writeFileSync(manifestPath, m);
console.log('AndroidManifest.xml mis à jour');

// 3) icône
const resSrc = path.join(root, 'native', 'res');
if (fs.existsSync(resSrc)) {
  const walk = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name), r = path.join(rel, e.name);
      if (e.isDirectory()) walk(p, r);
      else {
        const dest = path.join(appDir, 'res', r);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(p, dest);
      }
    }
  };
  walk(resSrc);
  // les icônes adaptatives du modèle utilisent un fond défini ici
  const bg = path.join(appDir, 'res', 'values', 'ic_launcher_background.xml');
  fs.mkdirSync(path.dirname(bg), { recursive: true });
  fs.writeFileSync(bg, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0A1316</color>\n</resources>\n');
  console.log('icônes copiées');
}

// 4) Signature stable + versionCode croissant : permet les mises à jour par-dessus l'ancienne version
{
  const gp = path.join(root, 'android', 'app', 'build.gradle');
  let g = fs.readFileSync(gp, 'utf8');
  const ks = path.join(root, 'signing', 'carnet.keystore').replace(/\\/g, '/');
  // versionCode = minutes écoulées depuis 1970 : toujours croissant, même si le dépôt change de nom ou si le compteur
  // d'exécutions GitHub repart de zéro (un versionCode plus bas que celui installé fait refuser la mise à jour).
  const run = parseInt(process.env.VERSION_CODE || String(Math.floor(Date.now() / 60000)), 10);
  const VER = require(path.join(root, 'package.json')).version;   // numérotation x.y : à changer dans package.json à chaque version
  g = g.replace(/versionCode\s+\d+/, `versionCode ${run}`).replace(/versionName\s+"[^"]*"/, `versionName "${VER}"`);
  if (!g.includes('signingConfigs')) {
    g = g.replace(/android\s*\{/, `android {\n    signingConfigs {\n        carnet {\n            storeFile file("${ks}")\n            storePassword "carnet2026"\n            keyAlias "carnet"\n            keyPassword "carnet2026"\n        }\n    }`);
    g = g.replace(/buildTypes\s*\{\s*\n?\s*debug\s*\{|buildTypes\s*\{/, (s) => s + `\n        debug { signingConfig signingConfigs.carnet }`);
  }
  fs.writeFileSync(gp, g);
  console.log('signature stable + versionCode', run);
}
