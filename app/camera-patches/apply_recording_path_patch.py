#!/usr/bin/env python3
"""Keep native MP4 output durable from creation, without a full cache copy."""
from pathlib import Path
import shutil
import sys
root = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
if (root / 'app/config.xml').exists():
    root = root / 'app'
source = root / 'plugins/cordova-plugin-camera-preview/src/android/CameraPreview.java'
s = source.read_text(encoding='utf-8')
marker = '// MULTICAM_DURABLE_RECORDING_PATH'
old = '    VIDEO_FILE_PATH = cordova.getActivity().getCacheDir().toString() + "/";'
new = '''    // MULTICAM_DURABLE_RECORDING_PATH
    VIDEO_FILE_PATH = cordova.getActivity().getFilesDir().toString() + "/recordings/";
    final File recordDirectory = new File(VIDEO_FILE_PATH);
    if (!recordDirectory.isDirectory() && !recordDirectory.mkdirs()) {
      callbackContext.error("recording_directory_unavailable");
      return true;
    }'''
if marker not in s:
    if s.count(old) != 1:
        raise SystemExit('Recording path anchor missing or ambiguous')
    s = s.replace(old, new, 1)
    source.write_text(s, encoding='utf-8')
platform = root / 'platforms/android/app/src/main/java/com/cordovaplugincamerapreview/CameraPreview.java'
if platform.parent.exists():
    shutil.copy2(source, platform)
print('Durable native recording path verified')
