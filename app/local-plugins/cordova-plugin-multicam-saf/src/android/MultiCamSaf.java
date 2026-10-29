package fr.emmanuel.multicam.saf;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

public class MultiCamSaf extends CordovaPlugin {
    private static final int REQ_TREE = 7413;
    private CallbackContext pendingChoose;
    @Override public boolean execute(String action, JSONArray args, CallbackContext callbackContext) throws JSONException {
        if ("chooseDirectory".equals(action)) { chooseDirectory(callbackContext); return true; }
        if ("testWrite".equals(action)) { testWrite(args.getString(0), callbackContext); return true; }
        if ("listPersisted".equals(action)) { listPersisted(callbackContext); return true; }
        if ("getTreeName".equals(action)) { getTreeName(args.getString(0), callbackContext); return true; }
        if ("saveVideo".equals(action)) { saveVideo(args.getString(0), args.optString(1, ""), callbackContext); return true; }
        return false;
    }

    // Retain a durable local source before publishing. Never remove a recording.
    private void saveVideo(final String source, final String tree, final CallbackContext cb) {
        cordova.getThreadPool().execute(() -> {
            JSONObject result = new JSONObject();
            try {
                java.io.File src = new java.io.File(source.replaceFirst("^file://", ""));
                if (!src.isFile() || src.length() == 0) throw new Exception("empty_or_missing_video");
                java.io.File dir = new java.io.File(cordova.getActivity().getFilesDir(), "recordings");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("mkdir_failed");
                String name = "MultiCam_" + System.currentTimeMillis() + "_" + java.util.UUID.randomUUID() + ".mp4";
                // New recordings already live in the durable directory.
                // Keep the copy fallback for files produced by older builds.
                java.io.File durable = src;
                if (!src.getCanonicalFile().getParentFile().equals(dir.getCanonicalFile())) {
                    durable = new java.io.File(dir, name);
                    try (java.io.InputStream in = new java.io.FileInputStream(src);
                         OutputStream out = new java.io.FileOutputStream(durable)) { copyVideo(in, out); }
                    if (durable.length() != src.length()) throw new Exception("local_copy_size_mismatch");
                }
                android.util.Log.i("MultiCamSaf", "VIDEO_DURABLE_READY path=" + durable + " reused=" + durable.equals(src) + " bytes=" + durable.length());
                result.put("path", durable.getAbsolutePath());
                result.put("bytes", durable.length());
                ContentResolver resolver = cordova.getActivity().getContentResolver();
                try {
                    Uri dest;
                    if (!tree.isEmpty()) {
                        Uri t = Uri.parse(tree);
                        Uri parent = DocumentsContract.buildDocumentUriUsingTree(t, DocumentsContract.getTreeDocumentId(t));
                        dest = DocumentsContract.createDocument(resolver, parent, "video/mp4", name);
                    } else {
                        android.content.ContentValues values = new android.content.ContentValues();
                        values.put(android.provider.MediaStore.Video.Media.DISPLAY_NAME, name);
                        values.put(android.provider.MediaStore.Video.Media.MIME_TYPE, "video/mp4");
                        values.put(android.provider.MediaStore.Video.Media.RELATIVE_PATH, "DCIM/MultiCam");
                        values.put(android.provider.MediaStore.Video.Media.IS_PENDING, 1);
                        dest = resolver.insert(android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values);
                    }
                    if (dest == null) throw new Exception("create_video_failed");
                    try (java.io.InputStream in = new java.io.FileInputStream(durable);
                         OutputStream out = resolver.openOutputStream(dest, "w")) {
                        if (out == null) throw new Exception("open_video_failed");
                        copyVideo(in, out);
                    }
                    try (android.os.ParcelFileDescriptor fd = resolver.openFileDescriptor(dest, "r")) {
                        if (fd == null || fd.getStatSize() != durable.length()) throw new Exception("published_size_mismatch");
                    }
                    if (tree.isEmpty()) {
                        android.content.ContentValues ready = new android.content.ContentValues();
                        ready.put(android.provider.MediaStore.Video.Media.IS_PENDING, 0);
                        resolver.update(dest, ready, null, null);
                    }
                    result.put("publicUri", dest.toString());
                    result.put("exported", true);
                    android.util.Log.i("MultiCamSaf", "VIDEO_LOCAL_SAVED path=" + durable + " uri=" + dest + " bytes=" + durable.length());
                } catch (Exception exportError) {
                    result.put("exported", false);
                    result.put("exportError", exportError.toString());
                    android.util.Log.e("MultiCamSaf", "VIDEO_PUBLIC_SAVE_FAILED local=" + durable, exportError);
                }
                cb.success(result);
            } catch (Exception e) {
                android.util.Log.e("MultiCamSaf", "VIDEO_LOCAL_SAVE_FAILED source=" + source, e);
                cb.error("save_video_failed: " + e.toString());
            }
        });
    }
    private static void copyVideo(java.io.InputStream in, OutputStream out) throws java.io.IOException {
        byte[] buf = new byte[128 * 1024]; int count;
        while ((count = in.read(buf)) != -1) out.write(buf, 0, count);
        out.flush();
    }

    private void chooseDirectory(CallbackContext callbackContext) {
        pendingChoose = callbackContext;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        cordova.startActivityForResult(this, intent, REQ_TREE);
    }
    @Override public void onActivityResult(int requestCode, int resultCode, Intent intent) {
        super.onActivityResult(requestCode, resultCode, intent);
        if (requestCode != REQ_TREE || pendingChoose == null) return;
        CallbackContext cb = pendingChoose; pendingChoose = null;
        if (resultCode != Activity.RESULT_OK || intent == null || intent.getData() == null) { cb.error("selection_cancelled"); return; }
        Uri uri = intent.getData();
        int flags = intent.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        try { cordova.getActivity().getContentResolver().takePersistableUriPermission(uri, flags); }
        catch (Exception e) { cb.error("persist_permission_failed: " + e.getMessage()); return; }
        JSONObject out = new JSONObject();
        try { out.put("uri", uri.toString()); out.put("read", (flags & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0); out.put("write", (flags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0); } catch (JSONException ignored) {}
        cb.success(out);
    }
    private void testWrite(final String treeUriString, final CallbackContext cb) {
        cordova.getThreadPool().execute(() -> {
            ContentResolver resolver = cordova.getActivity().getContentResolver(); Uri treeUri = Uri.parse(treeUriString); long started = System.currentTimeMillis();
            try {
                String treeDocId = DocumentsContract.getTreeDocumentId(treeUri); Uri parent = DocumentsContract.buildDocumentUriUsingTree(treeUri, treeDocId);
                String name = "multicam-saf-test-" + System.currentTimeMillis() + ".txt"; Uri created = DocumentsContract.createDocument(resolver, parent, "text/plain", name);
                if (created == null) throw new Exception("createDocument returned null");
                byte[] bytes = ("MultiCam SAF write test\n" + System.currentTimeMillis() + "\n").getBytes(StandardCharsets.UTF_8);
                try (OutputStream os = resolver.openOutputStream(created, "w")) { if (os == null) throw new Exception("openOutputStream returned null"); os.write(bytes); os.flush(); }
                boolean deleted = DocumentsContract.deleteDocument(resolver, created);
                JSONObject out = new JSONObject(); out.put("ok", true); out.put("uri", treeUriString); out.put("bytes", bytes.length); out.put("deleteOk", deleted); out.put("elapsedMs", System.currentTimeMillis() - started); cb.success(out);
            } catch (Exception e) {
                JSONObject out = new JSONObject(); try { out.put("ok", false); out.put("uri", treeUriString); out.put("error", e.getClass().getSimpleName() + ": " + e.getMessage()); out.put("elapsedMs", System.currentTimeMillis() - started); } catch (JSONException ignored) {} cb.error(out);
            }
        });
    }
    private void listPersisted(CallbackContext cb) {
        JSONArray arr = new JSONArray(); List<UriPermission> permissions = cordova.getActivity().getContentResolver().getPersistedUriPermissions();
        for (UriPermission p : permissions) { JSONObject o = new JSONObject(); try { o.put("uri", p.getUri().toString()); o.put("read", p.isReadPermission()); o.put("write", p.isWritePermission()); } catch (JSONException ignored) {} arr.put(o); }
        cb.success(arr);
    }
    private void getTreeName(final String treeUriString, final CallbackContext cb) {
        cordova.getThreadPool().execute(() -> {
            try {
                Uri treeUri = Uri.parse(treeUriString);
                ContentResolver resolver = cordova.getActivity().getContentResolver();
                String treeDocId = DocumentsContract.getTreeDocumentId(treeUri);
                Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, treeDocId);
                String name = null;
                Cursor c = resolver.query(docUri, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null);
                if (c != null) { try { if (c.moveToFirst()) name = c.getString(0); } finally { c.close(); } }
                JSONObject out = new JSONObject();
                out.put("uri", treeUriString);
                out.put("name", name != null && !name.isEmpty() ? name : null);
                cb.success(out);
            } catch (Exception e) {
                cb.error("get_tree_name_failed: " + e.getMessage());
            }
        });
    }
}
