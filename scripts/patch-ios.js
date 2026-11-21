// Exécuté après « npx cap add ios » : ajoute le plugin natif Swift, les permissions et les exceptions réseau local.
// Équivalent iOS de patch-android.js. N'est jamais appelé par la compilation Android.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appDir = path.join(root, 'ios', 'App', 'App');
const srcDir = path.join(root, 'native', 'ios');

// 1) fichiers Swift (le plugin BoatLink et le contrôleur qui l'enregistre)
for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith('.swift'))) {
  fs.copyFileSync(path.join(srcDir, f), path.join(appDir, f));
  console.log('copié', f);
}

// 2) Main.storyboard : utiliser notre contrôleur au lieu de CAPBridgeViewController
const sbPath = path.join(appDir, 'Base.lproj', 'Main.storyboard');
let sb = fs.readFileSync(sbPath, 'utf8');
if (!sb.includes('customClass="MainViewController"')) {
  const re = /customClass="CAPBridgeViewController"\s+customModule="Capacitor"(\s+customModuleProvider="target")?/;
  if (!re.test(sb)) throw new Error('Main.storyboard : CAPBridgeViewController introuvable (modèle Capacitor changé ?)');
  sb = sb.replace(re, 'customClass="MainViewController" customModule="App" customModuleProvider="target"');
  fs.writeFileSync(sbPath, sb);
}
console.log('Main.storyboard mis à jour');

// 3) Info.plist : permissions, réseau local, http/ws en clair, localisation en arrière-plan
const plPath = path.join(appDir, 'Info.plist');
let pl = fs.readFileSync(plPath, 'utf8');
const str = (k, v) => `\t<key>${k}</key>\n\t<string>${v}</string>\n`;
const add = [];
const want = {
  NSLocalNetworkUsageDescription: 'Le carnet de bord se connecte au boîtier Wi-Fi du bateau (YDWG-02, Signal K, Raspberry Pi, Cerbo GX).',
  NSLocationWhenInUseUsageDescription: 'Position du bateau pour le carnet de bord, le tracé des trajets et la météo.',
  NSLocationAlwaysAndWhenInUseUsageDescription: 'Garder le carnet de bord actif en navigation, écran verrouillé.',
  NSCameraUsageDescription: 'Photos du carnet de bord.',
  NSPhotoLibraryUsageDescription: 'Ajouter des photos au carnet de bord.',
  NSPhotoLibraryAddUsageDescription: 'Enregistrer des photos du carnet de bord.',
};
for (const [k, v] of Object.entries(want)) if (!pl.includes(`<key>${k}</key>`)) add.push(str(k, v));
if (!pl.includes('<key>UIBackgroundModes</key>')) {
  add.push('\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>location</string>\n\t</array>\n');
}
if (!pl.includes('<key>NSAppTransportSecurity</key>')) {
  add.push('\t<key>NSAppTransportSecurity</key>\n\t<dict>\n\t\t<key>NSAllowsArbitraryLoads</key>\n\t\t<true/>\n\t\t<key>NSAllowsLocalNetworking</key>\n\t\t<true/>\n\t</dict>\n');
}
if (add.length) {
  if (!/<\/dict>\s*<\/plist>\s*$/.test(pl)) throw new Error('Info.plist : fin inattendue');
  pl = pl.replace(/<\/dict>\s*<\/plist>\s*$/, add.join('') + '</dict>\n</plist>\n');
  fs.writeFileSync(plPath, pl);
}
console.log('Info.plist mis à jour');

// 4) version : même numérotation x.y que l'APK
const VER = require(path.join(root, 'package.json')).version;
const pbx = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
let p = fs.readFileSync(pbx, 'utf8');
p = p.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${VER};`)
     .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${process.env.BUILD_NUMBER || Math.floor(Date.now() / 60000)};`);
fs.writeFileSync(pbx, p);
console.log('version iOS', VER);
