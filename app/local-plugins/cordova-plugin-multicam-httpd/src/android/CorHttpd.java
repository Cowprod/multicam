package com.rjfun.cordova.httpd;

import java.io.IOException;
import java.net.BindException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.Enumeration;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;

import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.CallbackContext;
import org.apache.cordova.PluginResult;
import org.apache.cordova.PluginResult.Status;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import android.util.Log;
import android.content.Context;
import android.content.res.AssetManager;

/**
 * This class echoes a string called from JavaScript.
 */
public class CorHttpd extends CordovaPlugin {

    /** Common tag used for logging statements. */
    private static final String LOGTAG = "CorHttpd";
    
    /** Cordova Actions. */
    private static final String ACTION_START_SERVER = "startServer";
    private static final String ACTION_STOP_SERVER = "stopServer";
    private static final String ACTION_REGISTER_TAKE = "registerTake";
    private static final String ACTION_UNREGISTER_TAKE = "unregisterTake";
    private static final String ACTION_GET_URL = "getURL";
    private static final String ACTION_GET_LOCAL_PATH = "getLocalPath";
    
    private static final String OPT_WWW_ROOT = "www_root";
    private static final String OPT_PORT = "port";
    private static final String OPT_LOCALHOST_ONLY = "localhost_only";
    /* MultiCam: token d'accès exigé pour toute requête HTTP. */
    private static final String OPT_TOKEN = "token";
    /* MultiCam: identité du Take (clé du registre d'autorisations). */
    private static final String OPT_SESSION_ID = "sessionId";
    private static final String OPT_TAKE_NUMBER = "takeNumber";
    private static final String OPT_ROOT = "root";

    private String www_root = "";
	private int port = 8080;
	private boolean localhost_only = false;
	private String token = "";

	private String localPath = "";
	/* MultiCam: UN SEUL serveur par tablette Capture (idempotent). */
	private WebServer server = null;
	private String	url = "";

	/* MultiCam: registre des Takes autorisés, clé "sessionId/takeNumber" →
	 * { racine médias, token }. Les requêtes HTTP sont traitées sur des threads
	 * de session DISTINCTS du thread UI : la structure DOIT être thread-safe. */
	private final Map<String, Grant> grants = new ConcurrentHashMap<String, Grant>();

	/* MultiCam: autorisation d'accès au média d'UN Take. */
	static final class Grant {
		final AndroidFile root;
		final String token;
		Grant(AndroidFile root, String token) { this.root = root; this.token = token; }
	}

	private static String grantKey(String sessionId, int takeNumber) {
		return String.valueOf(sessionId) + "/" + takeNumber;
	}

    @Override
    public boolean execute(String action, JSONArray inputs, CallbackContext callbackContext) throws JSONException {
        PluginResult result = null;
        if (ACTION_START_SERVER.equals(action)) {
            result = startServer(inputs, callbackContext);
            
        } else if (ACTION_STOP_SERVER.equals(action)) {
            result = stopServer(inputs, callbackContext);
            
        } else if (ACTION_REGISTER_TAKE.equals(action)) {
            result = registerTake(inputs, callbackContext);

        } else if (ACTION_UNREGISTER_TAKE.equals(action)) {
            result = unregisterTake(inputs, callbackContext);

        } else if (ACTION_GET_URL.equals(action)) {
            result = getURL(inputs, callbackContext);
            
        } else if (ACTION_GET_LOCAL_PATH.equals(action)) {
            result = getLocalPath(inputs, callbackContext);
            
        } else {
            Log.d(LOGTAG, String.format("Invalid action passed: %s", action));
            result = new PluginResult(Status.INVALID_ACTION);
        }
        
        if(result != null) callbackContext.sendPluginResult( result );
        
        return true;
    }
    
    private String __getLocalIpAddress() {
    	try {
            for (Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces(); en.hasMoreElements();) {
                NetworkInterface intf = en.nextElement();
                for (Enumeration<InetAddress> enumIpAddr = intf.getInetAddresses(); enumIpAddr.hasMoreElements();) {
                    InetAddress inetAddress = enumIpAddr.nextElement();
                    if (! inetAddress.isLoopbackAddress()) {
                        if (inetAddress instanceof Inet4Address) {
                            String ip = inetAddress.getHostAddress();
                    		Log.w(LOGTAG, "local IP: "+ ip);
                    		return ip;
                    	}
                    }
                }
            }
        } catch (SocketException ex) {
            Log.e(LOGTAG, ex.toString());
        }
    	
		return "127.0.0.1";
    }

    private PluginResult startServer(JSONArray inputs, CallbackContext callbackContext) {
		Log.w(LOGTAG, "startServer");

        JSONObject options = inputs.optJSONObject(0);
        if(options == null) return null;
        
        www_root = options.optString(OPT_WWW_ROOT);
        port = options.optInt(OPT_PORT, 8080);
        localhost_only = options.optBoolean(OPT_LOCALHOST_ONLY, false);
        token = options.optString(OPT_TOKEN, "");
        
        if(www_root.startsWith("/")) {
    		//localPath = Environment.getExternalStorageDirectory().getAbsolutePath();
        	localPath = www_root;
        } else {
        	//localPath = "file:///android_asset/www";
        	localPath = "www";
        	if(www_root.length()>0) {
        		localPath += "/";
        		localPath += www_root;
        	}
        }

        final CallbackContext delayCallback = callbackContext;
        cordova.getActivity().runOnUiThread(new Runnable(){
			@Override
            public void run() {
				/* MultiCam: IDEMPOTENT. Un serveur déjà en écoute est RÉUTILISÉ
				 * tel quel : on ne retente JAMAIS un bind (cause de l'EADDRINUSE
				 * d'origine). */
				if (server != null) {
					Log.w(LOGTAG, "startServer: déjà en écoute, réutilisation url=" + url);
					delayCallback.success( url );
					return;
				}
				String errmsg = __startServer(port);
				if (errmsg.length() > 0) {
					delayCallback.error( errmsg );
				} else {
					int effective = server.getListeningPort();
					if (localhost_only) {
						url = "http://127.0.0.1:" + effective;
					} else {
						url = "http://" + __getLocalIpAddress() + ":" + effective;
					}
					Log.w(LOGTAG, "startServer: port demandé=" + port + " effectif=" + effective);
	                delayCallback.success( url );
				}
            }
        });
        
        return null;
    }
    
    private String __startServer(int preferredPort) {
    	String errmsg = "";
		AndroidFile f = new AndroidFile(localPath);
        Context ctx = cordova.getActivity().getApplicationContext();
		AssetManager am = ctx.getResources().getAssets();
		f.setAssetManager( am );
		try {
			server = __bind(preferredPort, f);
		} catch (IOException e) {
			/* MultiCam: conflit de port EXPLICITE. On ne masque PAS l'erreur
			 * avec setReuseAddress : on la journalise, puis on replie sur un port
			 * libre. L'URL annoncée portera le port réellement utilisé. */
			if (isPortConflict(e)) {
				Log.w(LOGTAG, "SERVE_PORT_CONFLICT port=" + preferredPort + " err=" + e.getMessage());
				try {
					server = __bind(0, f);
				} catch (IOException e2) {
					errmsg = String.format("IO Exception: %s", e2.getMessage());
					Log.w(LOGTAG, errmsg);
				}
			} else {
				errmsg = String.format("IO Exception: %s", e.getMessage());
				Log.w(LOGTAG, errmsg);
			}
		}
    	return errmsg;
    }

    /* MultiCam: construit un WebServer sur `port` (0 = port libre attribué par
     * l'OS) et lui installe le routeur multi-Take partagé. */
    private WebServer __bind(int port, AndroidFile f) throws IOException {
    	WebServer ws;
		if(localhost_only) {
			InetSocketAddress localAddr = new InetSocketAddress(InetAddress.getByAddress(new byte[]{127,0,0,1}), port);
			ws = new WebServer(localAddr, f);
		} else {
			ws = new WebServer(port, f);
		}
		ws.setTakeRouter(new TakeRouterImpl(grants));
		return ws;
    }

    private static boolean isPortConflict(IOException e) {
    	if (e instanceof BindException) return true;
    	String m = e.getMessage() == null ? "" : e.getMessage().toLowerCase();
    	return m.indexOf("eaddrinuse") >= 0 || m.indexOf("address already in use") >= 0;
    }

    private void __stopServer() {
		if (server != null) {
			server.stop();
			server = null;
		}
		/* MultiCam: plus aucune autorisation valable une fois le serveur arrêté. */
		grants.clear();
    }
    
   private PluginResult getURL(JSONArray inputs, CallbackContext callbackContext) {
		Log.w(LOGTAG, "getURL");
		
    	callbackContext.success( this.url );
        return null;
    }

    private PluginResult getLocalPath(JSONArray inputs, CallbackContext callbackContext) {
		Log.w(LOGTAG, "getLocalPath");
		
    	callbackContext.success( this.localPath );
        return null;
    }

    private PluginResult stopServer(JSONArray inputs, CallbackContext callbackContext) {
		Log.w(LOGTAG, "stopServer");
		
        final CallbackContext delayCallback = callbackContext;
        cordova.getActivity().runOnUiThread(new Runnable(){
			@Override
            public void run() {
				__stopServer();
				url = "";
				localPath = "";
                delayCallback.success();
            }
        });
        
        return null;
    }

    /* MultiCam: enregistre un Take (racine + token PROPRE). Appelé à l'annonce ;
     * le serveur HTTP (unique) doit déjà être démarré. Idempotent : ré-annoncer
     * le même Take écrase la même entrée sans créer de ressource. */
    private PluginResult registerTake(JSONArray inputs, CallbackContext callbackContext) {
		JSONObject o = inputs.optJSONObject(0);
		if (o == null) return new PluginResult(Status.ERROR, "missing_options");
		String sid = o.optString(OPT_SESSION_ID, "");
		int take = o.optInt(OPT_TAKE_NUMBER, -1);
		String root = o.optString(OPT_ROOT, "");
		String tk = o.optString(OPT_TOKEN, "");
		if (sid.length() == 0 || take < 0 || root.length() == 0 || tk.length() == 0) {
			Log.w(LOGTAG, "registerTake: paramètres invalides sid=" + sid + " take=" + take);
			return new PluginResult(Status.ERROR, "invalid_grant");
		}
		grants.put(grantKey(sid, take), new Grant(new AndroidFile(root), tk));
		Log.w(LOGTAG, "registerTake sid=" + sid + " take=" + take + " root=" + root + " grants=" + grants.size());
		return new PluginResult(Status.OK);
    }

    /* MultiCam: retire l'autorisation d'accès d'UN Take (suppression locale
     * validée). Le serveur HTTP et les AUTRES Takes restent intacts. */
    private PluginResult unregisterTake(JSONArray inputs, CallbackContext callbackContext) {
		JSONObject o = inputs.optJSONObject(0);
		if (o == null) return new PluginResult(Status.ERROR, "missing_options");
		String sid = o.optString(OPT_SESSION_ID, "");
		int take = o.optInt(OPT_TAKE_NUMBER, -1);
		if (sid.length() == 0 || take < 0) return new PluginResult(Status.ERROR, "invalid_grant");
		grants.remove(grantKey(sid, take));
		Log.w(LOGTAG, "unregisterTake sid=" + sid + " take=" + take + " grants=" + grants.size());
		return new PluginResult(Status.OK);
    }

    /**
     * Called when the system is about to start resuming a previous activity.
     *
     * @param multitasking		Flag indicating if multitasking is turned on for app
     */
    public void onPause(boolean multitasking) {
    	//if(! multitasking) __stopServer();
    }

    /**
     * Called when the activity will start interacting with the user.
     *
     * @param multitasking		Flag indicating if multitasking is turned on for app
     */
    public void onResume(boolean multitasking) {
    	//if(! multitasking) __startServer();
    }

    /**
     * The final call you receive before your activity is destroyed.
     */
    public void onDestroy() {
    	__stopServer();
    }

    /* MultiCam: routage multi-Take par chemin /<sessionId>/<takeNumber>/<rel>.
     * Le token exigé est CELUI DU TAKE visé (jamais un token global). Le
     * confinement au root du Take est vérifié segment par segment, en plus du
     * refus `../` déjà assuré par serveFile(). Exécuté sur les threads de
     * session HTTP : le registre `grants` est un ConcurrentHashMap. */
    private static final class TakeRouterImpl implements NanoHTTPD.TakeRouter {
    	private final Map<String, Grant> grants;
    	TakeRouterImpl(Map<String, Grant> grants) { this.grants = grants; }

    	@Override
    	public NanoHTTPD.Response serve(String uri, String method, Properties header,
    			Properties parms, Properties files, NanoHTTPD nano) {
    		if (uri == null) {
    			return nano.new Response(NanoHTTPD.HTTP_BADREQUEST, NanoHTTPD.MIME_PLAINTEXT, "BAD REQUEST");
    		}
    		String u = uri;
    		while (u.startsWith("/")) u = u.substring(1);
    		int i1 = u.indexOf('/');
    		int i2 = (i1 >= 0) ? u.indexOf('/', i1 + 1) : -1;
    		if (i1 <= 0 || i2 <= 0) {
    			return nano.new Response(NanoHTTPD.HTTP_NOTFOUND, NanoHTTPD.MIME_PLAINTEXT, "Error 404, file not found.");
    		}
    		String sid = u.substring(0, i1);
    		String take = u.substring(i1 + 1, i2);
    		String rel = u.substring(i2 + 1);
    		if (!safeSegment(sid) || !safeSegment(take) || !safeRel(rel)) {
    			Log.w(LOGTAG, "REJECT unsafe path uri=" + uri);
    			return nano.new Response(NanoHTTPD.HTTP_FORBIDDEN, NanoHTTPD.MIME_PLAINTEXT, "FORBIDDEN: invalid path.");
    		}
    		Grant g = grants.get(sid + "/" + take);
    		if (g == null) {
    			return nano.new Response(NanoHTTPD.HTTP_NOTFOUND, NanoHTTPD.MIME_PLAINTEXT, "Error 404, take not registered.");
    		}
    		String provided = parms != null ? parms.getProperty("token") : null;
    		boolean ok = provided != null && provided.equals(g.token);
    		if (!ok) {
    			String auth = header != null ? header.getProperty("authorization") : null;
    			ok = auth != null && auth.equals("Bearer " + g.token);
    		}
    		if (!ok) {
    			Log.w(LOGTAG, "REJECT token mismatch uri=" + uri);
    			return nano.new Response(NanoHTTPD.HTTP_FORBIDDEN, NanoHTTPD.MIME_PLAINTEXT, "FORBIDDEN: invalid token.");
    		}
    		return nano.serveFile("/" + rel, header, g.root, false);
    	}

    	private static boolean safeSegment(String s) {
    		return s != null && s.length() > 0 && !".".equals(s) && !"..".equals(s)
    				&& s.indexOf('\\') < 0 && s.indexOf('\0') < 0;
    	}

    	private static boolean safeRel(String rel) {
    		if (rel == null || rel.length() == 0) return false;
    		String[] ps = rel.split("/");
    		if (ps.length == 0) return false;
    		for (String p : ps) { if (!safeSegment(p)) return false; }
    		return true;
    	}
    }
}
