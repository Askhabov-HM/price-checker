package ru.pricechecker.lamoda;

import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.security.GeneralSecurityException;
import javax.net.ssl.SSLHandshakeException;
import org.junit.Test;
import static org.junit.Assert.*;

public class ConnectionIssueTest {
    @Test public void distinguishesExpiredInvitationsFromAuthenticationAndTemporaryHttpErrors() {
        Exception error = new Exception("private server response");
        assertEquals(ConnectionIssue.Kind.LINK,ConnectionIssue.kind(error,400,true));
        assertEquals(ConnectionIssue.Kind.HTTP,ConnectionIssue.kind(error,400,false));
        assertEquals(ConnectionIssue.Kind.AUTH,ConnectionIssue.kind(error,401,false));
        assertEquals(ConnectionIssue.Kind.BUSY,ConnectionIssue.kind(error,503,false));
        assertEquals(ConnectionIssue.Kind.BUSY,ConnectionIssue.kind(error,429,true));
        assertEquals(ConnectionIssue.Kind.REDIRECT,ConnectionIssue.kind(error,302,true));
        assertEquals(ConnectionIssue.Kind.RESPONSE,ConnectionIssue.kind(error,200,true));
    }
    @Test public void recognizesTransportAndSecureStorageFailuresIncludingWrappedCauses() {
        assertEquals(ConnectionIssue.Kind.TLS,ConnectionIssue.kind(new Exception(new SSLHandshakeException("private")),0,true));
        assertEquals(ConnectionIssue.Kind.DNS,ConnectionIssue.kind(new UnknownHostException(),0,true));
        assertEquals(ConnectionIssue.Kind.TIMEOUT,ConnectionIssue.kind(new SocketTimeoutException(),0,false));
        assertEquals(ConnectionIssue.Kind.CONNECT,ConnectionIssue.kind(new ConnectException(),0,false));
        assertEquals(ConnectionIssue.Kind.STORAGE,ConnectionIssue.kind(new GeneralSecurityException(),0,true));
    }
    @Test public void neverDisplaysUntrustedExceptionMessages() {
        String privateValue = "synthetic-secret-in-url-or-response";
        for (ConnectionIssue.Kind kind : ConnectionIssue.Kind.values())
            assertFalse(ConnectionIssue.message(kind).contains(privateValue));
        ConnectionIssue.Kind kind = ConnectionIssue.kind(new RuntimeException(privateValue),0,true);
        assertEquals(ConnectionIssue.Kind.UNKNOWN,kind);
        assertFalse(ConnectionIssue.message(kind).contains(privateValue));
    }
}
