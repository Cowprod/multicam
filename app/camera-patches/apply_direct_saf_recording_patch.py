#!/usr/bin/env python3
"""Patch CameraPreview to record directly into the selected SAF tree."""
from pathlib import Path
import shutil
import sys
root = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
if (root / 'app/config.xml').exists():
    root = root / 'app'
base = root / 'plugins/cordova-plugin-camera-preview'
preview = base / 'src/android/CameraPreview.java'
activity = base / 'src/android/CameraActivity.java'
wrapper = base / 'www/CameraPreview.js'
def patch(path, old, new):
    s = path.read_text(encoding='utf-8')
    if new in s:
        return
    if s.count(old) != 1:
        raise SystemExit('Direct SAF anchor missing or ambiguous: ' + str(path) + ': ' + old[:90])
    path.write_text(s.replace(old, new, 1), encoding='utf-8')
patch(wrapper, 'opts.camcorderProfile || null]);', 'opts.camcorderProfile || null, opts.safTreeUri || ""]);')
patch(preview, 'args.isNull(5) ? null : args.getString(5)), callbackContext);',
      'args.isNull(5) ? null : args.getString(5)), args.optString(6, ""), callbackContext);')
patch(preview, '(this.execArgs.isNull(5) ? null : this.execArgs.getString(5)), this.execCallback);',
      '(this.execArgs.isNull(5) ? null : this.execArgs.getString(5)), this.execArgs.optString(6, ""), this.execCallback);')
patch(preview, 'final String camcorderProfile, CallbackContext callbackContext) {',
      'final String camcorderProfile, final String safTreeUri, CallbackContext callbackContext) {')
patch(preview, 'fragment.startRecord(getFilePath(filename), camera, width, height, quality, withFlash, camcorderProfile);',
'''String target = getFilePath(filename);
        if (safTreeUri != null && !safTreeUri.isEmpty()) {
          try {
            android.net.Uri tree = android.net.Uri.parse(safTreeUri);
            android.net.Uri parent = android.provider.DocumentsContract.buildDocumentUriUsingTree(
                tree, android.provider.DocumentsContract.getTreeDocumentId(tree));
            String name = "MultiCam_" + System.currentTimeMillis() + "_" + java.util.UUID.randomUUID() + ".mp4";
            android.net.Uri doc = android.provider.DocumentsContract.createDocument(
                cordova.getActivity().getContentResolver(), parent, "video/mp4", name);
            if (doc == null) throw new java.io.IOException("saf_create_failed");
            target = doc.toString();
          } catch (Exception e) {
            onStartRecordVideoError("saf_create_failed: " + e.getMessage());
            return;
          }
        }
        fragment.startRecord(target, camera, width, height, quality, withFlash, camcorderProfile);''')
patch(activity, 'mRecorder.setOutputFile(filePath);',
'''if (filePath.startsWith("content://")) {
          directSafFd = activity.getContentResolver().openFileDescriptor(android.net.Uri.parse(filePath), "rw");
          if (directSafFd == null) throw new IOException("saf_open_failed");
          mRecorder.setOutputFile(directSafFd.getFileDescriptor());
        } else {
          mRecorder.setOutputFile(filePath);
        }''')
patch(activity, 'public void startRecord(final String filePath,',
'''private android.os.ParcelFileDescriptor directSafFd;

  private void closeDirectSafFd() {
    if (directSafFd != null) {
      try { directSafFd.close(); } catch (IOException ignored) {}
      directSafFd = null;
    }
  }

  public void startRecord(final String filePath,''')
patch(activity, 'mRecorder = null;\n      } catch (IllegalStateException stateException)',
      'mRecorder = null;\n        closeDirectSafFd();\n      } catch (IllegalStateException stateException)')
patch(activity, 'mRecorder = null;\n      } catch (Exception exception)',
      'mRecorder = null;\n        closeDirectSafFd();\n      } catch (Exception exception)')
patch(activity, 'mRecorder = null;\n      }\n    } else {',
      'mRecorder = null;\n        closeDirectSafFd();\n      }\n    } else {')
patch(activity, 'mRecorder = null;\n      mCamera.lock();',
      'mRecorder = null;\n      closeDirectSafFd();\n      mCamera.lock();')
patch(activity, 'eventListener.onStopRecordVideoError(e.getMessage());',
      'closeDirectSafFd();\n      eventListener.onStopRecordVideoError(e.getMessage());')
for name in ('CameraPreview.java', 'CameraActivity.java'):
    dest = root / 'platforms/android/app/src/main/java/com/cordovaplugincamerapreview' / name
    if dest.parent.exists():
        shutil.copy2(base / 'src/android' / name, dest)
print('Direct SAF MediaRecorder patch verified')
