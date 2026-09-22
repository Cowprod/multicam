#!/usr/bin/env node
/**
 * MultiCam J04 — after_prepare hook (versioned, décision 30.10).
 *
 * Active android:usesCleartextTraffic="true" sur le manifest <application> pour
 * permettre le client WebSocket ws:// LAN depuis l'origine http://localhost.
 *
 * Cordova n'a pas de préférence propre pour usesCleartextTraffic sur targetSdk >= 28
 * (edit-config injecte un préfixe `android:` non lié dans res/xml/config.xml et casse
 * la compilation aapt2). Ce hook édite UNIQUEMENT le manifest généré (fichier non
 * versionné) et est idempotent. Dérivé du hook POC C2
 * (tests/poc/websocket-server/c2-test/hooks/after_prepare/010-enable-cleartext.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const manifestPath = path.join('platforms', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

/* NB : Cordova 13 exécute les hooks DANS le processus CLI. Ne JAMAIS appeler
 * process.exit() ici : cela tuerait le build avant la phase gradle. On utilise
 * des retours anticipés et on lève une Error en cas d'échec réel. */
function main() {
  if (!fs.existsSync(manifestPath)) {
    console.log('[cleartext-hook] manifest not found, skipping');
    return;
  }

  let xml = fs.readFileSync(manifestPath, 'utf8');

  if (xml.indexOf('android:usesCleartextTraffic') !== -1) {
    console.log('[cleartext-hook] android:usesCleartextTraffic already present, skipping');
    return;
  }

  // inject the attribute on the <application ...> opening tag
  const m = xml.match(/<application\b([^>]*)>/);
  if (!m) {
    throw new Error('[cleartext-hook] <application> tag not found in ' + manifestPath);
  }
  const openTag = m[0];
  const attrs = m[1];
  const patchedOpenTag = '<application android:usesCleartextTraffic="true"' + (attrs ? attrs : '') + '>';
  xml = xml.replace(openTag, patchedOpenTag);

  fs.writeFileSync(manifestPath, xml);
  console.log('[cleartext-hook] injected android:usesCleartextTraffic="true" into ' + manifestPath);
}

main();