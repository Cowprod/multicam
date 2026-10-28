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
        if ("stage".equals(action)) {
            final String src = args.getString(0);
            final String dest = args.getString(1);
            cordova.getThreadPool().execute(() -> doStage(src, dest, callbackContext));
            return true;
        }
        if ("remove".equals(action)) {
            final String path = args.getString(0);
            cordova.getThreadPool().execute(() -> doRemove(path, callbackContext));
            return true;
        }
        if ("list".equals(action)) {
            final String path = args.getString(0);
            cordova.getThreadPool().execute(() -> doList(path, callbackContext));
            return true;
        }
        return false;
    }

    /* -------------------------------------------------------------------- list */

    /* J17-A — listing read-only des fichiers RÉGULIERS d'un dossier.
     *
     * Sert au catalogue média d'un Take archivé : le Storage vérifie ce qui
     * existe réellement sur son disque au lieu de croire un journal. Aucune
     * donnée média ne traverse le bridge (noms + tailles uniquement), aucun
     * chemin n'est accepté depuis le réseau (l'appelant JS construit le dossier
     * à partir de la session et du Take VALIDÉS localement). */
    private void doList(String path, CallbackContext cb) {
        try {
            File dir = new File(stripScheme(path));
            if (!dir.exists()) { cb.error("list_missing_dir"); return; }
            if (!dir.isDirectory()) { cb.error("list_not_dir"); return; }
            JSONArray entries = new JSONArray();
            File[] children = dir.listFiles();
            if (children != null) {
                java.util.Arrays.sort(children, (a, b) -> a.getName().compareTo(b.getName()));
                for (File c : children) {
                    if (!c.isFile()) continue;
                    JSONObject o = new JSONObject();
                    o.put("name", c.getName());
                    o.put("bytes", c.length());
                    o.put("dir", false);
                    entries.put(o);
                }
            }
            JSONObject res = new JSONObject();
            res.put("path", dir.getAbsolutePath());
            res.put("entries", entries);
            android.util.Log.i(LOGTAG, "TRANSFER_NATIVE list path=" + dir.getAbsolutePath()
                    + " files=" + entries.length());
            cb.success(res);
        } catch (Exception e) {
            android.util.Log.e(LOGTAG, "TRANSFER_NATIVE list error " + e);
            cb.error("list_failed: " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    /* ------------------------------------------------------------------ remove */

    /* Suppression d'un fichier local (segment stagé). Sert à la suppression
     * locale APRES réplication vérifiée : contrairement au HTML5 File API
     * (`resolveLocalFileSystemURL`), le natif accepte un chemin absolu nu et
     * rend un verdict réel. */
    private void doRemove(String path, CallbackContext cb) {
        try {
            File f = new File(stripScheme(path));
            boolean existed = f.exists();
            boolean removed = existed && f.delete();
            JSONObject res = new JSONObject();
            res.put("removed", removed);
            /* `existed` permet au JS de traiter « déjà absent » comme un succès
             * IDEMPOTENT (J14-C01 / D3) : une suppression rejouée ne doit pas
             * être vue comme un échec. */
            res.put("existed", existed);
            res.put("path", f.getAbsolutePath());
            android.util.Log.i(LOGTAG, "TRANSFER_NATIVE remove path=" + f.getAbsolutePath()
                    + " existed=" + existed + " removed=" + removed);
            cb.success(res);
        } catch (Exception e) {
            android.util.Log.e(LOGTAG, "TRANSFER_NATIVE remove error " + e);
            cb.error("remove_failed: " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    /* ------------------------------------------------------------------- stage */

    /* Déplace (ou copie) un fichier local vers une destination absolue, en
     * créant les dossiers parents. Utilisé par la Capture pour STAGER le
     * segment enregistré dans le cache interne vers l'arborescence média
     * `MultiCam/<sid>/<take>/` servie en HTTP. Idempotent : une destination
     * existante est remplacée. `renameTo` échoue à travers les systèmes de
     * fichiers (cache interne → stockage externe) : repli copie+suppression. */
    private void doStage(String src, String dest, CallbackContext cb) {
        try {
            File s = new File(stripScheme(src));
            File d = new File(stripScheme(dest));
            if (!s.exists()) { cb.error("stage_missing_src"); return; }
            File parent = d.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            if (d.exists() && !d.delete()) { cb.error("stage_delete_dest_failed"); return; }
            if (!s.renameTo(d)) {
                try (InputStream in = new FileInputStream(s); OutputStream out = new FileOutputStream(d)) {
                    byte[] buf = new byte[BUF];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                s.delete();
            }
            JSONObject res = new JSONObject();
            res.put("dest", d.getAbsolutePath());
            res.put("bytes", d.length());
            android.util.Log.i(LOGTAG, "TRANSFER_NATIVE stage src=" + s.getAbsolutePath()
                    + " dest=" + d.getAbsolutePath() + " bytes=" + d.length());
            cb.success(res);
        } catch (Exception e) {
            android.util.Log.e(LOGTAG, "TRANSFER_NATIVE stage error " + e);
            cb.error("stage_failed: " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
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

        /* J14-B03 : la reprise DOIT rester cohérente avec les octets réellement
         * présents sur le disque. Le modèle JS fournit l'offset de progression,
         * mais si le fichier contient plus d'octets que la progression signalée
         * (flush, latence de callback), appender à l'offset LOGIQUE duplique des
         * octets → fichier corrompu (taille plausible, SHA-256 faux). En mode
         * fichier, la taille de la destination fait FOI : on reprend exactement
         * là où le disque s'est arrêté. */
        if (dest.length() > 0 && offset > 0) {
            File df = new File(dest);
            long onDisk = df.exists() ? df.length() : 0L;
            if (onDisk != offset) {
                android.util.Log.i(LOGTAG, "TRANSFER_NATIVE resume adjusted requested=" + offset
                        + " onDisk=" + onDisk + " dest=" + dest);
                offset = onDisk;
            }
        }

        /* J15 (§4/§16) : en mode SAF, le fichier de destination est RECRÉÉ
         * (delete + create) à chaque écriture — une reprise d'OCTETS est donc
         * impossible (elle écrirait à la suite d'un fichier tronqué, produisant
         * un SHA faux SILENCIEUX). On repart TOUJOURS de zéro : c'est une reprise
         * du TRAVAIL, pas des octets. */
        if (treeUri.length() > 0 && offset > 0) {
            android.util.Log.i(LOGTAG, "TRANSFER_NATIVE saf_restart_from_zero requested=" + offset);
            offset = 0;
        }

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
            } else if (code == HttpURLConnection.HTTP_PARTIAL) {
                /* J15 (§4.3) : un 206 DOIT démarrer exactement à l'offset demandé,
                 * sinon les octets suivants écriraient une plage différente de
                 * celle attendue (fichier incohérent, taille plausible). */
                String cr = conn.getHeaderField("Content-Range");
                long start = parseContentRangeStart(cr);
                if (offset > 0 && start >= 0 && start != offset) {
                    android.util.Log.e(LOGTAG, "TRANSFER_NATIVE range_mismatch requested=" + offset
                            + " contentRange=" + cr);
                    cb.error("download_range_mismatch: requested=" + offset + " got=" + cr);
                    return;
                }
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
                /* J14-B03 : aligner la taille du fichier sur l'offset de reprise
                 * avant d'appender — jamais d'octets résiduels au-delà de la
                 * position demandée. */
                if (offset > 0) {
                    try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "rw")) {
                        raf.setLength(offset);
                    }
                }
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

            /* J14-C01 / D2 : le serveur annonce `Content-Length`. Si le flux se
             * termine AVANT la taille attendue, le fichier est TRONQUÉ : on
             * échoue explicitement (message clair) au lieu de produire
             * l'empreinte d'un contenu incomplet. C'est la conséquence visible
             * de l'ancienne borne de longueur 32 bits côté serveur, qui se
             * manifestait sinon en `ProtocolException` opaque. */
            if (total > 0 && written != total) {
                android.util.Log.e(LOGTAG, "TRANSFER_NATIVE download truncated received=" + written + " expected=" + total);
                cb.error("download_truncated: received=" + written + " expected=" + total);
                return;
            }

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

    /* Extrait la borne de début d'un en-tête `Content-Range: bytes S-E/T`.
     * Rend -1 si l'en-tête est absent/illisible (on ne peut alors pas valider). */
    private static long parseContentRangeStart(String cr) {
        if (cr == null) return -1L;
        try {
            int sp = cr.indexOf(' ');
            int dash = cr.indexOf('-');
            if (sp < 0 || dash < 0 || dash <= sp + 1) return -1L;
            return Long.parseLong(cr.substring(sp + 1, dash).trim());
        } catch (Exception e) {
            return -1L;
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
