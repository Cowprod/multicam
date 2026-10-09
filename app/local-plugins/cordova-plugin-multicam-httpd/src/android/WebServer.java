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
}
