#!/usr/bin/env node
/**
 * after_prepare hook — enable cleartext WebSocket (ws://) for the POC WebView client.
 *
 * Cordova has no clean built-in for android:usesCleartextTraffic on targetSdk >= 28
 * (edit-config also injects an unbound `android:` prefix into res/xml/config.xml,
 * which breaks aapt2 resource compilation). This hook edits the generated
 * source manifest only and is idempotent.
 *
 * This is POC infrastructure, NOT a modification of the websocket plugin under test.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const manifestPath = path.join('platforms', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

if (!fs.existsSync(manifestPath)) {
  console.log('[cleartext-hook] manifest not found, skipping');
  process.exit(0);
}

let xml = fs.readFileSync(manifestPath, 'utf8');

if (xml.indexOf('android:usesCleartextTraffic') !== -1) {
  console.log('[cleartext-hook] android:usesCleartextTraffic already present, skipping');
  process.exit(0);
}

// inject the attribute on the <application ...> opening tag
const m = xml.match(/<application\b([^>]*)>/);
if (!m) {
  console.error('[cleartext-hook] <application> tag not found');
  process.exit(1);
}
const openTag = m[0];
const attrs = m[1];
const patchedOpenTag = '<application android:usesCleartextTraffic="true"' + (attrs ? attrs : '') + '>';
xml = xml.replace(openTag, patchedOpenTag);

fs.writeFileSync(manifestPath, xml);
console.log('[cleartext-hook] injected android:usesCleartextTraffic="true" into ' + manifestPath);