package fr.emmanuel.multicam.transfer;

import android.content.Context;
import android.net.Uri;

import androidx.documentfile.provider.DocumentFile;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * MultiCam J11 — brique native de transfert média.
 *
 * Deux opérations, toutes deux HORS bridge JS pour les données (aucun média ne
 * traverse le WebView) :
 *
 *   sha256   : empreinte SHA-256 d'un fichier, en STREAMING (jamais tout en RAM).
 *   download : GET HTTP d'un fichier distance avec reprise (`Range: bytes=N-`)
 *              et écriture STREAMING vers un fichier local OU une arborescence
 *              SAF, progression périodique, puis SHA-256 du fichier final.
 *
 * Journalisation : ActionLog natif (logcat) `TRANSFER_NATIVE …` pour les preuves.
 */
public class MultiCamTransfer extends CordovaPlugin {

    private static final String LOGTAG = "MultiCamTransfer";
    private static final int BUF = 64 * 1024;
    private static final long PROGRESS_EVERY_MS = 250L;

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callbackContext) throws JSONException {
        if ("sha256".equals(action)) {
            final String path = args.getString(0);
            cordova.getThreadPool().execute(() -> doSha256(path, callbackContext));
            return true;
        }
        if ("download".equals(action)) {
            final JSONObject opts = args.getJSONObject(0);
            cordova.getThreadPool().execute(() -> doDownload(opts, callbackContext));
            return true;
        }
        return false;
    }

    /* ------------------------------------------------------------------ sha256 */

    private void doSha256(String path, CallbackContext cb) {
        try {
            String sha = sha256OfFile(path);
            JSONObject out = new JSONObject();
            out.put("sha256", sha);
            out.put("bytes", new File(stripScheme(path)).length());
            cb.success(out);
        } catch (Exception e) {
            cb.error("sha256_failed: " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    private static String stripScheme(String path) {
        if (path == null) return "";
        if (path.startsWith("file://")) return Uri.parse(path).getPath();
        return path;
    }

    private static String sha256OfFile(String path) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(stripScheme(path))) {
            byte[] buf = new byte[BUF];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        return toHex(md.digest());
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
        return sb.toString();
    }

    /* ---------------------------------------------------------------- download */

    private void doDownload(JSONObject o, CallbackContext cb) {
        String url = o.optString("url", "");
        String token = o.optString("token", "");
        String dest = o.optString("dest", "");          /* fichier absolu (mode file) */
        String treeUri = o.optString("treeUri", "");     /* arborescence SAF (mode saf) */
        String relPath = o.optString("relPath", "");     /* chemin relatif sous treeUri */
        long offset = o.optLong("offset", 0L);
        long expected = o.optLong("expectedBytes", -1L);

        if (url.length() == 0) { cb.error("download_missing_url"); return; }
        if (dest.length() == 0 && (treeUri.length() == 0 || relPath.length() == 0)) {
            cb.error("download_missing_dest"); return;
        }

        HttpURLConnection conn = null;
        OutputStream out = null;
        InputStream in = null;
        try {
            if (token.length() > 0) {
                String sep = url.contains("?") ? "&" : "?";
                url = url + sep + "token=" + Uri.encode(token);
            }
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("Accept-Encoding", "identity");
            if (offset > 0) conn.setRequestProperty("Range", "bytes=" + offset + "-");

            int code = conn.getResponseCode();
            long total = expected > 0 ? expected : conn.getContentLengthLong() + offset;

            if (code == HttpURLConnection.HTTP_OK && offset > 0) {
                /* Le serveur a ignoré le Range : on repart de zéro. */
                offset = 0;
            } else if (code != HttpURLConnection.HTTP_OK && code != 206) {
                cb.error("download_http_" + code);
                return;
            }

            in = conn.getInputStream();
            long written = offset;
            long lastProgress = 0L;
            byte[] buf = new byte[BUF];
            int n;

            if (treeUri.length() > 0) {
                Context ctx = cordova.getActivity().getApplicationContext();
                DocumentFile dir = DocumentFile.fromTreeUri(ctx, Uri.parse(treeUri));
                if (dir == null) { cb.error("saf_tree_denied"); return; }
                String name = relPath.substring(relPath.lastIndexOf('/') + 1);
                String sub = relPath.contains("/") ? relPath.substring(0, relPath.lastIndexOf('/')) : "";
                DocumentFile parent = ensureDirs(ctx, dir, sub);
                if (parent == null) { cb.error("saf_mkdir_failed"); return; }
                DocumentFile exist = parent.findFile(name);
                if (exist != null) exist.delete();
                DocumentFile file = parent.createFile("application/octet-stream", name);
                if (file == null) { cb.error("saf_create_failed"); return; }
                out = ctx.getContentResolver().openOutputStream(file.getUri(), "w");
            } else {
                File f = new File(dest);
                File parent = f.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();
                out = new FileOutputStream(f, offset > 0); /* append si reprise */
            }
            if (out == null) { cb.error("download_open_dest_failed"); return; }

            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                written += n;
                long now = System.currentTimeMillis();
                if (now - lastProgress >= PROGRESS_EVERY_MS) {
                    lastProgress = now;
                    JSONObject p = new JSONObject();
                    p.put("progress", true);
                    p.put("received", written);
                    p.put("total", total);
                    PluginResult pr = new PluginResult(PluginResult.Status.OK, p);
                    pr.setKeepCallback(true);
                    cb.sendPluginResult(pr);
                }
            }
            out.flush();
            out.close();
            out = null;
            in.close();
            in = null;

            String sha = (treeUri.length() > 0)
                    ? "saf_unverified"  /* SAF : hash calculé côté appelant si besoin */
                    : sha256OfFile(dest);

            JSONObject res = new JSONObject();
            res.put("done", true);
            res.put("received", written);
            res.put("total", total);
            res.put("sha256", sha);
            android.util.Log.i(LOGTAG, "TRANSFER_NATIVE download done received=" + written + " total=" + total + " sha256=" + sha);
            cb.success(res);
        } catch (Exception e) {
            android.util.Log.e(LOGTAG, "TRANSFER_NATIVE download error " + e);
            cb.error("download_failed: " + e.getClass().getSimpleName() + ": " + e.getMessage());
        } finally {
            try { if (in != null) in.close(); } catch (Exception ignored) {}
            try { if (out != null) out.close(); } catch (Exception ignored) {}
            if (conn != null) conn.disconnect();
        }
    }

    private static DocumentFile ensureDirs(Context ctx, DocumentFile root, String sub) {
        DocumentFile cur = root;
        if (sub == null || sub.length() == 0) return cur;
        for (String part : sub.split("/")) {
            if (part.length() == 0) continue;
            DocumentFile next = cur.findFile(part);
            if (next == null || !next.isDirectory()) {
                next = cur.createDirectory(part);
            }
            if (next == null) return null;
            cur = next;
        }
        return cur;
    }
}
