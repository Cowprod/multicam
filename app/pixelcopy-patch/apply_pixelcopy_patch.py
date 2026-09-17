#!/usr/bin/env python3
from pathlib import Path
import sys, shutil
ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
PLUGIN = ROOT / 'plugins' / 'cordova-plugin-camera-preview'
files = {'activity': PLUGIN/'src/android/CameraActivity.java','preview': PLUGIN/'src/android/CameraPreview.java','js': PLUGIN/'www/CameraPreview.js'}
for path in files.values():
    if not path.exists(): raise SystemExit('ERREUR: fichier introuvable: %s' % path)
def backup(path):
    bak=Path(str(path)+'.bak-pixelcopy')
    if not bak.exists(): shutil.copy2(path,bak)
def replace_once(text,old,new,label):
    if new in text: print('DEJA OK:',label); return text
    if old not in text: raise SystemExit('ERREUR: anchor introuvable pour %s' % label)
    return text.replace(old,new,1)
p=files['activity']; backup(p); s=p.read_text(encoding='utf-8')
s=replace_once(s,'import android.os.Handler;\n','import android.os.Handler;\nimport android.os.Build;\nimport android.os.Looper;\n','imports Build/Looper')
s=replace_once(s,'import android.view.MotionEvent;\n','import android.view.MotionEvent;\nimport android.view.PixelCopy;\n','import PixelCopy')
s=replace_once(s,'    void onSnapshotTakenError(String message);\n','    void onSnapshotTakenError(String message);\n    void onPreviewSurfaceCaptured(String base64Jpeg);\n    void onPreviewSurfaceCaptureError(String message);\n','listener PixelCopy')
anchor='  public void takeSnapshot(final int quality) {\n'
method=r'''  public void capturePreviewSurface(final int quality) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) { if (eventListener != null) eventListener.onPreviewSurfaceCaptureError("PixelCopy requires Android API 24+"); return; }
    if (mPreview == null || mPreview.mSurfaceView == null) { if (eventListener != null) eventListener.onPreviewSurfaceCaptureError("Preview SurfaceView unavailable"); return; }
    final SurfaceView surfaceView = mPreview.mSurfaceView;
    final int bitmapWidth = surfaceView.getWidth(), bitmapHeight = surfaceView.getHeight();
    if (bitmapWidth <= 0 || bitmapHeight <= 0) { if (eventListener != null) eventListener.onPreviewSurfaceCaptureError("Preview SurfaceView has invalid size: " + bitmapWidth + "x" + bitmapHeight); return; }
    if (surfaceView.getHolder() == null || surfaceView.getHolder().getSurface() == null || !surfaceView.getHolder().getSurface().isValid()) { if (eventListener != null) eventListener.onPreviewSurfaceCaptureError("Preview Surface is not valid"); return; }
    final Bitmap bitmap = Bitmap.createBitmap(bitmapWidth, bitmapHeight, Bitmap.Config.ARGB_8888);
    try {
      PixelCopy.request(surfaceView, bitmap, new PixelCopy.OnPixelCopyFinishedListener() {
        @Override public void onPixelCopyFinished(int copyResult) {
          if (copyResult == PixelCopy.SUCCESS) {
            try { ByteArrayOutputStream output = new ByteArrayOutputStream(); int jpegQuality = Math.max(0, Math.min(100, quality)); bitmap.compress(Bitmap.CompressFormat.JPEG, jpegQuality, output); String base64 = Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP); output.close(); if (eventListener != null) eventListener.onPreviewSurfaceCaptured(base64); }
            catch (Exception e) { if (eventListener != null) eventListener.onPreviewSurfaceCaptureError("JPEG encode failed: " + e.getMessage()); }
            finally { bitmap.recycle(); }
          } else { bitmap.recycle(); if (eventListener != null) eventListener.onPreviewSurfaceCaptureError("PixelCopy failed with code " + copyResult); }
        }
      }, new Handler(Looper.getMainLooper()));
    } catch (Exception e) { bitmap.recycle(); if (eventListener != null) eventListener.onPreviewSurfaceCaptureError("PixelCopy exception: " + e.getMessage()); }
  }

'''
if method not in s:
    if anchor not in s: raise SystemExit('ERREUR: anchor takeSnapshot CameraActivity introuvable')
    s=s.replace(anchor,method+anchor,1)
p.write_text(s,encoding='utf-8')
p=files['preview']; backup(p); s=p.read_text(encoding='utf-8')
s=replace_once(s,'  private static final String TAKE_SNAPSHOT_ACTION = "takeSnapshot";\n','  private static final String TAKE_SNAPSHOT_ACTION = "takeSnapshot";\n  private static final String CAPTURE_PREVIEW_SURFACE_ACTION = "capturePreviewSurface";\n','action constant')
s=replace_once(s,'  private CallbackContext takeSnapshotCallbackContext;\n','  private CallbackContext takeSnapshotCallbackContext;\n  private CallbackContext capturePreviewSurfaceCallbackContext;\n','callback field')
s=replace_once(s,'    } else if (TAKE_SNAPSHOT_ACTION.equals(action)) {\n      return takeSnapshot(args.getInt(0), callbackContext);\n    }else if (START_RECORD_VIDEO_ACTION.equals(action)) {','    } else if (TAKE_SNAPSHOT_ACTION.equals(action)) {\n      return takeSnapshot(args.getInt(0), callbackContext);\n    } else if (CAPTURE_PREVIEW_SURFACE_ACTION.equals(action)) {\n      return capturePreviewSurface(args.getInt(0), callbackContext);\n    } else if (START_RECORD_VIDEO_ACTION.equals(action)) {','execute PixelCopy')
anchor='  private boolean takeSnapshot(int quality, CallbackContext callbackContext) {\n'
methods=r'''  private boolean capturePreviewSurface(int quality, CallbackContext callbackContext) {
    if (this.hasView(callbackContext) == false) return true;
    capturePreviewSurfaceCallbackContext = callbackContext;
    if (fragment != null) fragment.capturePreviewSurface(quality);
    return true;
  }
  @Override public void onPreviewSurfaceCaptured(String base64Jpeg) {
    if (capturePreviewSurfaceCallbackContext != null) { PluginResult result = new PluginResult(PluginResult.Status.OK, base64Jpeg); result.setKeepCallback(false); capturePreviewSurfaceCallbackContext.sendPluginResult(result); capturePreviewSurfaceCallbackContext = null; }
  }
  @Override public void onPreviewSurfaceCaptureError(String message) {
    if (capturePreviewSurfaceCallbackContext != null) { capturePreviewSurfaceCallbackContext.error(message); capturePreviewSurfaceCallbackContext = null; }
  }

'''
if methods not in s:
    if anchor not in s: raise SystemExit('ERREUR: anchor takeSnapshot CameraPreview introuvable')
    s=s.replace(anchor,methods+anchor,1)
p.write_text(s,encoding='utf-8')
p=files['js']; backup(p); s=p.read_text(encoding='utf-8'); anchor='CameraPreview.takePicture = function(opts, onSuccess, onError) {\n'
wrapper=r'''CameraPreview.capturePreviewSurface = function(opts, onSuccess, onError) {
  if (!opts) { opts = {}; } else if (isFunction(opts)) { onSuccess = opts; opts = {}; }
  if (!isFunction(onSuccess)) return false;
  if (!opts.quality || opts.quality > 100 || opts.quality < 0) opts.quality = 85;
  exec(onSuccess, onError, PLUGIN_NAME, "capturePreviewSurface", [opts.quality]);
};

'''
if wrapper not in s:
    if anchor not in s: raise SystemExit('ERREUR: anchor takePicture CameraPreview.js introuvable')
    s=s.replace(anchor,wrapper+anchor,1)
p.write_text(s,encoding='utf-8')
print('Patch PixelCopy appliqué:',PLUGIN)
