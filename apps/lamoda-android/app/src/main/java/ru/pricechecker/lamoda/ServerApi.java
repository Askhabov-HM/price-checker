package ru.pricechecker.lamoda;

import org.json.JSONObject;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.KeyStore;
import java.security.cert.X509Certificate;
import java.security.cert.CertificateException;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

final class ServerApi {
    private final String origin;
    private final String token;
    ServerApi(String origin, String token) { this.origin = AddressPolicy.server(origin); this.token = token; }
    private static boolean pinned(X509Certificate cert) {
        try {
            cert.checkValidity();
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
            StringBuilder hex = new StringBuilder(); for (byte value : bytes) hex.append(String.format("%02x", value & 255));
            return hex.toString().equals(BuildConfig.SERVER_CERT_SHA256);
        } catch (Exception error) { return false; }
    }
    private void configureTls(HttpsURLConnection connection) throws Exception {
        if (!origin.equals(BuildConfig.DEFAULT_SERVER)) return;
        TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); factory.init((KeyStore) null);
        X509TrustManager system = (X509TrustManager) factory.getTrustManagers()[0];
        SSLContext ssl = SSLContext.getInstance("TLS");
        ssl.init(null, new TrustManager[]{new X509TrustManager() {
            public X509Certificate[] getAcceptedIssuers() { return system.getAcceptedIssuers(); }
            public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException { system.checkClientTrusted(chain, auth); }
            public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                if (chain.length > 0 && pinned(chain[0])) return;
                system.checkServerTrusted(chain, auth);
            }
        }}, null);
        connection.setSSLSocketFactory(ssl.getSocketFactory());
        connection.setHostnameVerifier((host, session) -> {
            if (HttpsURLConnection.getDefaultHostnameVerifier().verify(host, session)) return true;
            try { return host.equals("153.76.171.172") && pinned((X509Certificate) session.getPeerCertificates()[0]); }
            catch (Exception error) { return false; }
        });
    }
    JSONObject call(String action, JSONObject body) throws Exception {
        if (!action.matches("pair|next|start|page|fail")) throw new IllegalArgumentException("Некорректное действие.");
        HttpsURLConnection connection = (HttpsURLConnection) new URL(origin + "/api/lamoda-mobile/" + action).openConnection();
        try {
            configureTls(connection); connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
            connection.setRequestProperty("Accept", "application/json");
            if (!token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                if (bytes.length > 2 * 1024 * 1024) throw new IllegalArgumentException("Ответ избранного слишком большой.");
                connection.setRequestMethod("POST"); connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json"); connection.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw new IllegalStateException("Сервер перенаправляет запрос. Проверьте адрес.");
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (stream == null) throw new IllegalStateException("Сервер недоступен: HTTP " + status);
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (stream) {
                byte[] buffer = new byte[8192]; int length;
                while ((length = stream.read(buffer)) != -1) { if (output.size() + length > 128 * 1024) throw new IllegalStateException("Неожиданный ответ сервера."); output.write(buffer, 0, length); }
            }
            JSONObject result;
            try { result = new JSONObject(output.toString(StandardCharsets.UTF_8.name())); }
            catch (Exception error) { throw new IllegalStateException("Сервер ещё не поддерживает Android-сбор или указан неверный адрес."); }
            if (status < 200 || status >= 300) throw new IllegalStateException(result.optString("error", "Ошибка сервера: HTTP " + status));
            return result;
        } finally { connection.disconnect(); }
    }
}
