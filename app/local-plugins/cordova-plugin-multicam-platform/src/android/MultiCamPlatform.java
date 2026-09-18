package fr.emmanuel.multicam.platform;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.StatFs;
import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Enumeration;

public class MultiCamPlatform extends CordovaPlugin {
    private static Intent lastIntent;

    @Override public boolean execute(String action, JSONArray args, CallbackContext cb) throws JSONException {
        if ("freeSpace".equals(action)) { freeSpace(args.getString(0), cb); return true; }
        if ("ipv4".equals(action)) { ipv4(cb); return true; }
        if ("intentExtra".equals(action)) { intentExtra(args.getString(0), cb); return true; }
        return false;
    }

    @Override public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        lastIntent = intent;
    }

    private void freeSpace(final String path, final CallbackContext cb) {
        cordova.getThreadPool().execute(() -> {
            try {
                StatFs sf = new StatFs(path);
                JSONObject out = new JSONObject();
                out.put("path", path);
                out.put("availableBytes", sf.getAvailableBytes());
                out.put("totalBytes", sf.getTotalBytes());
                cb.success(out);
            } catch (Exception e) {
                cb.error("statfs_failed: " + e.getMessage());
            }
        });
    }

    private void ipv4(CallbackContext cb) {
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            String candidate = null;
            while (ifaces != null && ifaces.hasMoreElements()) {
                NetworkInterface nif = ifaces.nextElement();
                if (!nif.isUp() || nif.isLoopback()) continue;
                Enumeration<InetAddress> addrs = nif.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        String ip = addr.getHostAddress();
                        if (candidate == null && !nif.getName().startsWith("tun")) candidate = ip;
                        if (!nif.getName().startsWith("tun")) { candidate = ip; break; }
                    }
                }
                if (candidate != null) break;
            }
            JSONObject out = new JSONObject();
            out.put("ipv4", candidate);
            out.put("networkType", networkType());
            cb.success(out);
        } catch (Exception e) {
            cb.error("ipv4_failed: " + e.getMessage());
        }
    }

    private String networkType() {
        try {
            ConnectivityManager cm = (ConnectivityManager) cordova.getActivity().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return "unknown";
            Network n = cm.getActiveNetwork();
            if (n == null) return "none";
            NetworkCapabilities caps = cm.getNetworkCapabilities(n);
            if (caps == null) return "unknown";
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "wifi";
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "cellular";
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "ethernet";
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return "vpn";
            return "other";
        } catch (Exception e) {
            return "unknown";
        }
    }

    private void intentExtra(String name, CallbackContext cb) {
        try {
            int flags = cordova.getActivity().getApplicationInfo().flags;
            boolean debug = (flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
            if (!debug) { cb.error("debug_only"); return; }
            Intent intent = lastIntent != null ? lastIntent : cordova.getActivity().getIntent();
            String value = intent != null ? intent.getStringExtra(name) : null;
            cb.success(value != null ? value : "");
        } catch (Exception e) {
            cb.error("intent_extra_failed: " + e.getMessage());
        }
    }
}