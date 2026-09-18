package fr.emmanuel.multicam.nsd;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

import org.json.JSONObject;

/**
 * MultiCam J03 — endpoint minimal disponible sur le LAN (port 45101 par defaut).
 *
 * Volontairement limite a une seule route : GET /health (JSON identite locale).
 * Ceci sert UNIQUEMENT de preuve de joignabilite du port annonce en mDNS a J03.
 * Ce n'est pas une architecture J04/J11 : le protocole final (session, WS, HTTP de
 * transfert) sera conçu a son jalon respectif. Ne PAS faire evoluer ce serveur
 * au-dela de /health avant decision.
 */
public class HealthServer {
    public interface Listener {
        void onRequest(String remote, String path, int status, int code, long bytes);
    }

    public static final int DEFAULT_PORT = 45101;
    private static final int PORT_TRIES = 10;
    private static final int SO_TIMEOUT_MS = 30000;

    private volatile ServerSocket server;
    private volatile Thread thread;
    private volatile int port = -1;
    private volatile JSONObject identity = new JSONObject();
    private final Listener listener;

    public HealthServer(Listener listener) {
        this.listener = listener;
    }

    public synchronized boolean start(JSONObject identityPayload) {
        stop();
        if (identityPayload != null) this.identity = identityPayload;
        int base = DEFAULT_PORT;
        for (int i = 0; i < PORT_TRIES; i++) {
            try {
                ServerSocket ss = new ServerSocket();
                ss.setReuseAddress(true);
                ss.bind(new InetSocketAddress("0.0.0.0", base + i));
                this.server = ss;
                this.port = base + i;
                break;
            } catch (Exception ignored) {
                server = null;
            }
        }
        if (server == null) return false;
        thread = new Thread(this::serve, "multicam-health");
        thread.setDaemon(true);
        thread.start();
        return true;
    }

    public int port() {
        return port;
    }

    public void updateIdentity(JSONObject identityPayload) {
        if (identityPayload != null) this.identity = identityPayload;
    }

    public synchronized void stop() {
        ServerSocket ss = server;
        server = null;
        if (ss != null) {
            try { ss.close(); } catch (Exception ignored) {}
        }
        Thread t = thread;
        thread = null;
        if (t != null && t.isAlive()) {
            try { t.join(600); } catch (InterruptedException ignored) {}
        }
        port = -1;
    }

    private void serve() {
        ServerSocket ss = server;
        if (ss == null) return;
        while (ss == server) {
            try {
                Socket socket = ss.accept();
                handle(socket);
            } catch (Exception e) {
                if (ss != server) break;
            }
        }
    }

    private void handle(Socket socket) {
        try {
            socket.setSoTimeout(SO_TIMEOUT_MS);
            String remote = socket.getRemoteSocketAddress() != null
                    ? socket.getRemoteSocketAddress().toString() : "?";
            BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            String first = in.readLine();
            String path = first != null ? first.split(" ")[1] : "/";
            boolean ok = first != null && first.startsWith("GET ") && path.equals("/health");
            JSONObject body = new JSONObject();
            if (ok) {
                try { body.put("ok", true).put("deviceId", identity.optString("deviceId"))
                             .put("deviceName", identity.optString("deviceName"))
                             .put("version", identity.optString("version")); }
                catch (Exception ignored) {}
            } else {
                try { body.put("ok", false); } catch (Exception ignored) {}
            }
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            OutputStream out = socket.getOutputStream();
            StringBuilder head = new StringBuilder();
            head.append("HTTP/1.1 ").append(ok ? "200 OK" : "404 Not Found").append("\r\n");
            head.append("Content-Type: application/json\r\n");
            head.append("Content-Length: ").append(payload.length).append("\r\n");
            head.append("Connection: close\r\n\r\n");
            out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
            out.write(payload);
            out.flush();
            if (listener != null) listener.onRequest(remote, path, ok ? 200 : 404, ok ? 0 : 1, payload.length + head.length());
        } catch (Exception ignored) {
        } finally {
            try { socket.close(); } catch (Exception ignored) {}
        }
    }
}