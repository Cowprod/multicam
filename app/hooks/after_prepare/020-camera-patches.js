/* Native patches must survive plugin restore and every Cordova build. */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
module.exports = function (context) {
  const root = context.opts.projectRoot;
  const scripts = [
    'pixelcopy-patch/apply_pixelcopy_patch.py',
    '../tests/poc/capture-profile-selection/patch/apply_capture_profile_patch.py',
    'camera-patches/apply_capture_capabilities_patch.py',
    'camera-patches/apply_video_permission_patch.py',
    'camera-patches/apply_camera_switch_patch.py',
    'camera-patches/apply_recording_path_patch.py'
  ];
  for (const script of scripts) {
    execFileSync('python3', [path.resolve(root, script), root], { cwd: root, stdio: 'inherit' });
  }
  // Cordova wraps plugin modules at install time, before the patches run.
  // Keep the wrapper and update both generated JS copies after prepare.
  const pluginJs = fs.readFileSync(path.join(root, 'plugins/cordova-plugin-camera-preview/www/CameraPreview.js'), 'utf8');
  const wrapped = 'cordova.define("cordova-plugin-camera-preview.CameraPreview", function(require, exports, module) {\n' + pluginJs + '\n});\n';
  for (const base of ['platforms/android/platform_www', 'platforms/android/app/src/main/assets/www']) {
    const target = path.join(root, base, 'plugins/cordova-plugin-camera-preview/www/CameraPreview.js');
    if (!fs.existsSync(target)) throw new Error('Camera plugin JS missing: ' + target);
    fs.writeFileSync(target, wrapped);
  }
  // Local plugin edits must also reach the Java sources Gradle compiles.
  for (const [plugin, file, packageDir] of [
    ['cordova-plugin-multicam-saf', 'MultiCamSaf.java', 'saf'],
    ['cordova-plugin-multicam-transfer', 'MultiCamTransfer.java', 'transfer']
  ]) {
    const source = path.join(root, 'local-plugins', plugin, 'src/android', file);
    for (const target of [
      path.join(root, 'plugins', plugin, 'src/android', file),
      path.join(root, 'platforms/android/app/src/main/java/fr/emmanuel/multicam', packageDir, file)
    ]) {
      if (!fs.existsSync(target)) throw new Error('Local media plugin missing: ' + target);
      fs.copyFileSync(source, target);
    }
  }
};
