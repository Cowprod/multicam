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
        return false;
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
