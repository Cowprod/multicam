package fr.emmanuel.multicam.nsd;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Cordova plugin : mDNS/DNS-SD via NsdManager (Android) + GET /health.
 *
 * Stratégies native :
 * - API >= 34 : discoverServices(String, int, DiscoveryListener) + per-service
 *               registerServiceInfoCallback(NsdServiceInfo, Executor, ServiceInfoCallback)
 *               (mises à jour live de l'adresse/TXT sans redécouvrir manuellement).
 * - API < 34  : discoverServices(String, int, DiscoveryListener) + resolveService(info, ResolveListener)
 *               (résolution unique par service, re-resolve au cas par cas).
 *
 * Voir aussi AGENTS.md / DECISIONS_REFERENCE pour la règle : "préférer un plugin local
 * mince et contrôlé aux plugins tiers opaques". Ce plugin suit le pattern de
 * cordova-plugin-multicam-platform.
 *
 * Android 17 / API 37 : l'accès au réseau local peut nécessiter ACCESS_LOCAL_NETWORK.
 * Ce plugin ne déclare PAS cette permission sur API 36 (elle n'existe pas) ; il est
 * structuré pour que l'ajout futur soit localisé (section ACCESS_LOCAL_NETWORK_FUTURE).
 * Exécuter `adb shell am compat enable RESTRICT_LOCAL_NETWORK fr.emmanuel.multicam`
 * pour expérimenter la restriction sur API 36 (NsdManager est affecté par les appels
 * sortants de sockets mais pas par les appels au NsdManager système).
 */
public class MultiCamNsd extends org.apache.cordova.CordovaPlugin {
    private static final String TAG = "MCNsd";

    private NsdManager nsdManager;
    private Handler mainHandler;
    private CallbackContext eventsCtx;
    private JSONObject lastCfg;

    /* Identity (from J02 config). */
    private String localDid = "";
    private String deviceName = "";
    private String serviceType = "_multicam._tcp.";
    private int requestedPort = HealthServer.DEFAULT_PORT;
    private int healthPort = -1;
    private int sver = 1;
    private String version = "";
    private boolean multicastLockEnabled = false;
    private boolean running = false;

    /* Registration. */
    private NsdServiceInfo regInfo;
    private NsdManager.RegistrationListener regListener;
    private String registeredName = "";

    /* Discovery. */
    private NsdManager.DiscoveryListener discoveryListener;
    private final ConcurrentHashMap<String, NsdManager.ServiceInfoCallback> infoCallbacks = new ConcurrentHashMap<>();
    private NsdManager.ResolveListener resolveListener;
    private volatile boolean discoveryRunning = false;

    /* Health server. */
    private HealthServer healthServer;
    private JSONObject healthIdentity = new JSONObject();

    /* Network monitoring. */
    private BroadcastReceiver netReceiver;
    private long lastRestartMs = 0;
    private final Runnable restartRunnable = this::restartNsd;

    /* Multicast lock. */
    private WifiManager.MulticastLock multicastLock;

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext cb) throws JSONException {
        cordova.getThreadPool().execute(() -> {
            try {
                switch (action) {
                    case "start":
                        doStart(args.getJSONObject(0), cb);
                        break;
                    case "reannounce":
                        doReannounce(args.getJSONObject(0), cb);
                        break;
                    case "stop":
                        doStop();
                        cb.success();
                        break;
                    case "status":
                        cb.success(statusJson());
                        break;
                    case "probeLocalAccess":
                        doProbe(args.getJSONObject(0), cb);
                        break;
                    case "events":
                        eventsCtx = cb;
                        JSONObject ack = new JSONObject();
                        ack.put("channel", "nsd_events");
                        sendEvent("eventsReady", ack);
                        break;
                    default:
                        cb.error("Unknown action: " + action);
                }
            } catch (Exception e) {
                cb.error("MCNsd error: " + e.getMessage());
            }
        });
        return true;
    }

    /* ---------- lifecycle ---------- */

    private void doStart(JSONObject cfg, CallbackContext cb) throws JSONException {
        if (running) {
            cb.success(statusJson());
            return;
        }
        localDid = cfg.optString("deviceId", "");
        deviceName = cfg.optString("deviceName", "");
        requestedPort = cfg.optInt("port", HealthServer.DEFAULT_PORT);
        serviceType = cfg.optString("serviceType", "_multicam._tcp.");
        sver = cfg.optInt("sver", 1);
        version = cfg.optString("version", "");
        multicastLockEnabled = cfg.optBoolean("multicastLock", false);
        buildIdentity(cfg);

        running = true;
        lastCfg = cfg;
        lastRestartMs = System.currentTimeMillis();
        mainHandler = new Handler(Looper.getMainLooper());
        if (nsdManager == null) nsdManager = (NsdManager) cordova.getActivity().getSystemService(Context.NSD_SERVICE);
        logNsdPath();

        /* Health server. */
        if (healthServer == null) {
            healthServer = new HealthServer((remote, path, status, code, bytes) ->
                    sendHealthRequest(remote, path, status, code, bytes));
        }
        if (healthServer.port() < 0) healthServer.start(buildHealthIdentity());
        healthPort = healthServer.port();
        sendHealthServerStart();

        /* Register NSD service on the real bound port. */
        buildRegListener();
        registerService(buildServiceInfo(deviceName, healthPort, cfg));

        /* Start discovery. */
        buildDiscoveryListener();
        startDiscovery();

        /* Network receiver. */
        startNetReceiver();

        /* Multicast lock. */
        if (multicastLockEnabled) acquireMulticastLock();

        sendAdvertiseStart();
        cb.success(statusJson());
    }

    private void doReannounce(JSONObject cfg, CallbackContext cb) throws JSONException {
        if (!running) { cb.error("not_running"); return; }
        deviceName = cfg.optString("deviceName", deviceName);
        requestedPort = cfg.optInt("port", healthPort);
        buildIdentity(cfg);
        lastCfg = cfg;
        healthServer.updateIdentity(buildHealthIdentity());
        try { nsdManager.unregisterService(regListener); } catch (Exception ignored) {}
        registerService(buildServiceInfo(deviceName, healthPort, cfg));
        JSONObject data = new JSONObject();
        data.put("deviceId", localDid).put("deviceName", deviceName);
        sendEvent("reannounced", data);
        cb.success();
    }

    private void doStop() {
        if (!running) return;
        running = false;
        stopNetReceiver();
        stopDiscovery();
        try { nsdManager.unregisterService(regListener); } catch (Exception ignored) {}
        if (healthServer != null) healthServer.stop();
        releaseMulticastLock();
        JSONObject data = new JSONObject();
        try { data.put("reason", "app_stop"); } catch (Exception ignored) {}
        sendEvent("advertiseStopped", data);
    }

    /* ---------- registration ---------- */

    private void buildRegListener() {
        regListener = new NsdManager.RegistrationListener() {
            @Override public void onServiceRegistered(NsdServiceInfo s) {
                registeredName = s.getServiceName();
                JSONObject d = new JSONObject();
                try { d.put("registeredName", registeredName); } catch (Exception ignored) {}
                sendEvent("advertised", d);
            }
            @Override public void onRegistrationFailed(NsdServiceInfo s, int code) {
                sendError("registerFailed", code, s != null ? s.getServiceName() : null);
            }
            @Override public void onServiceUnregistered(NsdServiceInfo s) {}
            @Override public void onUnregistrationFailed(NsdServiceInfo s, int code) {
                sendError("unregisterFailed", code, null);
            }
        };
    }

    private void registerService(NsdServiceInfo info) {
        try {
            regInfo = info;
            nsdManager.registerService(info, NsdManager.PROTOCOL_DNS_SD, regListener);
        } catch (Exception e) {
            sendError("registerException", -1, e.getMessage());
        }
    }

    private NsdServiceInfo buildServiceInfo(String name, int port, JSONObject cfg) throws JSONException {
        NsdServiceInfo info = new NsdServiceInfo();
        info.setServiceName(name);
        info.setServiceType(serviceType);
        info.setPort(port);
        if (cfg.has("deviceId")) info.setAttribute("did", cfg.getString("deviceId"));
        if (cfg.has("deviceName")) info.setAttribute("dname", cfg.getString("deviceName"));
        if (cfg.has("supportedSkills")) {
            String s = jsonArrayToCsv(cfg.getJSONArray("supportedSkills"));
            if (s.length() > 0) info.setAttribute("supported", s);
        }
        if (cfg.has("enabledSkills")) {
            String e = jsonArrayToCsv(cfg.getJSONArray("enabledSkills"));
            if (e.length() > 0) info.setAttribute("enabled", e);
        }
        if (version.length() > 0) info.setAttribute("ver", version);
        info.setAttribute("sver", String.valueOf(sver));
        return info;
    }

    private static String jsonArrayToCsv(JSONArray arr) throws JSONException {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < arr.length(); i++) {
            Object o = arr.opt(i);
            if (o == null) continue;
            String v = String.valueOf(o).replace(',', '_');
            if (v.length() == 0) continue;
            if (sb.length() > 0) sb.append(',');
            sb.append(v);
        }
        return sb.toString();
    }

    /* ---------- discovery ---------- */

    private void buildDiscoveryListener() {
        discoveryListener = new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String t) {
                discoveryRunning = true;
                sendEvent("discoveryStarted", new JSONObject());
            }
            @Override public void onDiscoveryStopped(String t) {
                discoveryRunning = false;
                sendEvent("discoveryStopped", new JSONObject());
            }
            @Override public void onServiceFound(NsdServiceInfo s) {
                if (s.getServiceType() == null || !s.getServiceType().equalsIgnoreCase(serviceType)) return;
                String name = s.getServiceName();
                if (isSelfName(name)) return;
                JSONObject d = new JSONObject();
                try { d.put("serviceName", name); d.put("serviceType", s.getServiceType()); } catch (Exception ignored) {}
                sendEvent("serviceFound", d);
                if (Build.VERSION.SDK_INT >= 34) {
                    startInfoCallback(s);
                } else {
                    resolve(s);
                }
            }
            @Override public void onServiceLost(NsdServiceInfo s) {
                String name = s != null ? s.getServiceName() : null;
                if (isSelfName(name)) return;
                /* If a per-service callback is active it will also fire onServiceLost;
                 * emit here only if no callback registered (before first update). */
                if (name == null || infoCallbacks.containsKey(name)) return;
                JSONObject d = new JSONObject();
                try { d.put("serviceName", name); d.put("serviceType", s != null ? s.getServiceType() : ""); } catch (Exception ignored) {}
                sendEvent("serviceLost", d);
            }
            @Override public void onStartDiscoveryFailed(String t, int code) {
                sendError("discoverStartFailed", code, null);
            }
            @Override public void onStopDiscoveryFailed(String t, int code) {
                sendError("discoverStopFailed", code, null);
            }
        };
    }

    private void startDiscovery() {
        try {
            nsdManager.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
        } catch (Exception e) {
            sendError("discoverException", -1, e.getMessage());
        }
    }

    /* Modern path (API 34+): per-service callback for live updates. */
    private void startInfoCallback(NsdServiceInfo info) {
        String name = info.getServiceName();
        if (infoCallbacks.containsKey(name)) return;
        NsdManager.ServiceInfoCallback cb = new NsdManager.ServiceInfoCallback() {
            @Override public void onServiceUpdated(NsdServiceInfo updated) {
                emitServiceUpdated(updated);
            }
            @Override public void onServiceLost() {
                infoCallbacks.remove(name);
                if (isSelfName(name)) return;
                JSONObject d = new JSONObject();
                try { d.put("serviceName", name); } catch (Exception ignored) {}
                sendEvent("serviceLost", d);
            }
            @Override public void onServiceInfoCallbackRegistrationFailed(int code) {
                infoCallbacks.remove(name);
                sendError("sicRegFailed", code, name);
            }
            @Override public void onServiceInfoCallbackUnregistered() {
                infoCallbacks.remove(name);
            }
        };
        infoCallbacks.put(name, cb);
        try {
            nsdManager.registerServiceInfoCallback(info, cordova.getActivity().getMainExecutor(), cb);
        } catch (Exception e) {
            infoCallbacks.remove(name);
            sendError("sicRegisterException", -1, e.getMessage());
        }
    }

    /* Legacy path (< API 34): one-shot resolve. */
    private void resolve(NsdServiceInfo info) {
        if (resolveListener == null) {
            resolveListener = new NsdManager.ResolveListener() {
                @Override public void onServiceResolved(NsdServiceInfo resolved) {
                    emitServiceUpdated(resolved);
                }
                @Override public void onResolveFailed(NsdServiceInfo info, int code) {
                    sendError("resolveFailed", code, info != null ? info.getServiceName() : null);
                }
            };
        }
        try {
            nsdManager.resolveService(info, resolveListener);
        } catch (Exception e) {
            sendError("resolveException", -1, e.getMessage());
        }
    }

    /* Common event from updated/resolved service info. */
    private void emitServiceUpdated(NsdServiceInfo info) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("serviceName", info.getServiceName());
            payload.put("serviceType", info.getServiceType());

            /* TXT */
            JSONObject txt = new JSONObject();
            Map<String, byte[]> attrs = info.getAttributes();
            if (attrs != null) {
                for (Map.Entry<String, byte[]> e : attrs.entrySet()) {
                    txt.put(e.getKey(), new String(e.getValue(), StandardCharsets.UTF_8));
                }
            }
            payload.put("txt", txt);

            /* self filter: if did matches local → skip entirely. */
            String did = txt.has("did") ? txt.getString("did") : "";
            if (did.equals(localDid)) return;

            /* Host / address. */
            String host = "";
            if (Build.VERSION.SDK_INT >= 34) {
                List<InetAddress> addrs = info.getHostAddresses();
                if (addrs != null) {
                    for (InetAddress a : addrs) {
                        if (a instanceof Inet4Address) { host = a.getHostAddress(); break; }
                    }
                    if (host.isEmpty() && !addrs.isEmpty()) host = addrs.get(0).getHostAddress();
                }
            }
            if (host.isEmpty() && info.getHost() != null) host = info.getHost().getHostAddress();
            payload.put("host", host != null ? host : "");
            payload.put("port", info.getPort());
            try {
                if (Build.VERSION.SDK_INT >= 23) {
                    android.net.Network network = info.getNetwork();
                    if (network != null) payload.put("networkId", network.getNetworkHandle());
                }
            } catch (Exception ignored) {}

            sendEvent("serviceUpdated", payload);
        } catch (Exception e) {
            sendError("emitServiceUpdatedFailed", -1, e.getMessage());
        }
    }

    /* ---------- health server ---------- */

    private JSONObject buildHealthIdentity() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("deviceId", localDid).put("deviceName", deviceName).put("version", version);
        return o;
    }

    private void sendHealthServerStart() {
        JSONObject d = new JSONObject();
        try { d.put("port", healthPort); } catch (Exception ignored) {}
        sendEvent("healthServerStart", d);
    }

    private void sendAdvertiseStart() {
        JSONObject d = new JSONObject();
        try { d.put("deviceId", localDid).put("deviceName", deviceName).put("port", healthPort); } catch (Exception ignored) {}
        sendEvent("advertiseStart", d);
    }

    private void sendHealthRequest(String remote, String path, int status, int code, long bytes) {
        JSONObject d = new JSONObject();
        try { d.put("remote", remote).put("path", path).put("status", status).put("code", code).put("bytes", bytes); } catch (Exception ignored) {}
        sendEvent("healthRequest", d);
    }

    /* ---------- network monitoring ---------- */

    private void startNetReceiver() {
        if (netReceiver != null) return;
        netReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context ctx, Intent i) {
                if (!running) return;
                String type = getNetworkType(ctx);
                String ipv4 = getLocalIPv4();
                JSONObject d = new JSONObject();
                try { d.put("networkType", type != null ? type : "unknown").put("ipv4", ipv4); } catch (Exception ignored) {}
                sendEvent("netChanged", d);
                mainHandler.removeCallbacks(restartRunnable);
                mainHandler.postDelayed(restartRunnable, 1500);
            }
        };
        IntentFilter f = new IntentFilter();
        f.addAction(ConnectivityManager.CONNECTIVITY_ACTION);
        cordova.getActivity().registerReceiver(netReceiver, f);
    }

    private void stopNetReceiver() {
        if (netReceiver != null) {
            try { cordova.getActivity().unregisterReceiver(netReceiver); } catch (Exception ignored) {}
            netReceiver = null;
        }
        mainHandler.removeCallbacks(restartRunnable);
    }

    private void restartNsd() {
        if (!running) return;
        long now = System.currentTimeMillis();
        if (now - lastRestartMs < 4500) return;
        lastRestartMs = now;
        /* Redemarrage de la DECOUVERTE uniquement. On ne de/en-registre PAS le
         * service : unregisterService est asynchrone et une re-registration
         * immediate race ("listener already in use"). Apres changement de
         * reseau, NsdManager re-annonce lui-meme l'adresse mise a jour du
         * service enregistre ; les pairs la re-resolvent via serviceUpdated. */
        stopDiscovery();
        startDiscovery();
        JSONObject d = new JSONObject();
        try { d.put("reason", "network_change"); } catch (Exception ignored) {}
        sendEvent("reannounced", d);
    }

    private void stopDiscovery() {
        /* Modern path: unregister every per-service callback (even pre-discoverystart). */
        for (Map.Entry<String, NsdManager.ServiceInfoCallback> e : infoCallbacks.entrySet()) {
            try { nsdManager.unregisterServiceInfoCallback(e.getValue()); } catch (Exception ignored) {}
        }
        infoCallbacks.clear();
        if (discoveryListener != null) {
            try { nsdManager.stopServiceDiscovery(discoveryListener); } catch (Exception ignored) {}
        }
        discoveryRunning = false;
    }

    /* ---------- multicast lock ---------- */

    private void acquireMulticastLock() {
        try {
            WifiManager wm = (WifiManager) cordova.getActivity().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                multicastLock = wm.createMulticastLock("mcMdns");
                multicastLock.setReferenceCounted(false);
                multicastLock.acquire();
            }
        } catch (Exception ignored) {}
    }

    private void releaseMulticastLock() {
        if (multicastLock != null) {
            try { multicastLock.release(); } catch (Exception ignored) {}
            multicastLock = null;
        }
    }

    /* ---------- probe ---------- */

    private void doProbe(JSONObject cfg, CallbackContext cb) {
        String host = cfg.optString("host", "");
        int port = cfg.optInt("port", 0);
        int timeout = cfg.optInt("timeoutMs", 1500);
        long start = System.currentTimeMillis();
        try {
            Socket s = new Socket();
            s.connect(new java.net.InetSocketAddress(host, port), timeout);
            s.close();
            JSONObject d = new JSONObject();
            d.put("ok", true).put("ms", System.currentTimeMillis() - start);
            cb.success(d);
        } catch (Exception e) {
            try {
                JSONObject d = new JSONObject();
                d.put("ok", false).put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
                d.put("ms", System.currentTimeMillis() - start);
                cb.success(d);
            } catch (Exception ignored) { cb.error(e.getMessage()); }
        }
    }

    /* ---------- identity / status ---------- */

    private void buildIdentity(JSONObject cfg) throws JSONException {
        JSONObject i = new JSONObject();
        i.put("deviceId", localDid).put("deviceName", deviceName).put("version", version);
        healthIdentity = i;
    }

    private JSONObject statusJson() {
        try {
            JSONObject s = new JSONObject();
            s.put("running", running);
            s.put("registeredName", registeredName);
            s.put("advertising", running && registeredName.length() > 0);
            s.put("port", healthPort);
            s.put("serviceType", serviceType);
            s.put("localDeviceId", localDid);
            s.put("localName", deviceName);
            if (lastCfg != null) s.put("localCfg", lastCfg);
            s.put("networkType", getNetworkType(cordova.getActivity()));
            s.put("ipv4", getLocalIPv4());
            s.put("sdk", Build.VERSION.SDK_INT);
            s.put("multicastLock", multicastLockEnabled && multicastLock != null);
            s.put("nsdPath", Build.VERSION.SDK_INT >= 34 ? "modern:registerServiceInfoCallback" : "legacy:resolveService");
            s.put("discoveryActive", discoveryRunning);
            return s;
        } catch (Exception e) { return new JSONObject(); }
    }

    private void logNsdPath() {
        String path = Build.VERSION.SDK_INT >= 34 ? "modern" : "legacy";
        JSONObject d = new JSONObject();
        try { d.put("nsdPath", path).put("sdk", Build.VERSION.SDK_INT); } catch (Exception ignored) {}
        sendEvent("nsdPath", d);
    }

    /* Un service decouvert qui porte notre propre nom = notre propre annonce. */
    private boolean isSelfName(String name) {
        if (name == null) return false;
        return name.equals(registeredName) || name.equals(deviceName);
    }

    /* ---------- helpers ---------- */

    private void sendEvent(String type, JSONObject data) {
        if (eventsCtx == null) return;
        try { data.put("type", type).put("ts", System.currentTimeMillis()); } catch (Exception ignored) {}
        sendPluginResult(data);
    }

    private void sendError(String code, int nativeCode, String detail) {
        JSONObject d = new JSONObject();
        try {
            d.put("type", "error").put("ts", System.currentTimeMillis())
              .put("code", code).put("nativeCode", nativeCode);
            if (detail != null) d.put("detail", detail);
        } catch (Exception ignored) {}
        sendPluginResult(d);
    }

    private void sendPluginResult(JSONObject data) {
        if (eventsCtx == null) return;
        try {
            PluginResult pr = new PluginResult(PluginResult.Status.OK, data);
            pr.setKeepCallback(true);
            cordova.getActivity().runOnUiThread(() -> eventsCtx.sendPluginResult(pr));
        } catch (Exception ignored) {}
    }

    private String getNetworkType(Context ctx) {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return "unknown";
            NetworkInfo ni = cm.getActiveNetworkInfo();
            return ni != null ? ni.getTypeName().toLowerCase() : "none";
        } catch (Exception e) { return "unknown"; }
    }

    private String getLocalIPv4() {
        try {
            String candidate = null;
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InetAddress addr : Collections.list(nif.getInetAddresses())) {
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        candidate = addr.getHostAddress();
                        if (!nif.getName().startsWith("tun")) return candidate;
                    }
                }
            }
            return candidate;
        } catch (Exception e) { return null; }
    }

    @Override
    public void onDestroy() {
        doStop();
        super.onDestroy();
    }
}