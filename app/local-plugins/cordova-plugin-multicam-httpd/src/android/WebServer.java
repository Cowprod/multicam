package com.rjfun.cordova.httpd;

import java.io.IOException;
import java.net.InetSocketAddress;

public class WebServer extends NanoHTTPD
{
	public WebServer(InetSocketAddress localAddr, AndroidFile wwwroot) throws IOException {
		super(localAddr, wwwroot);
	}

	public WebServer(int port, AndroidFile wwwroot ) throws IOException {
		super(port, wwwroot);
	}

	/* MultiCam: construit le serveur puis fixe le token d'accès exigé. */
	public WebServer(int port, AndroidFile wwwroot, String token) throws IOException {
		super(port, wwwroot);
		setAccessToken(token);
	}

	/* MultiCam: serveur UNIQUE multi-Take. Le routeur résout
	 * /<sessionId>/<takeNumber>/<rel> et vérifie le token PROPRE au Take ; la
	 * racine passée ici n'est qu'un point d'ancrage, chaque requête étant servie
	 * depuis la racine de son Take (voir le registre des Takes). */
	public WebServer(int port, AndroidFile wwwroot, NanoHTTPD.TakeRouter router) throws IOException {
		super(port, wwwroot);
		setTakeRouter(router);
	}
}
