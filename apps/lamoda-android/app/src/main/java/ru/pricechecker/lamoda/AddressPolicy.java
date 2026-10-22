package ru.pricechecker.lamoda;

import java.net.URI;

final class AddressPolicy {
    static String server(String value) {
        URI uri = URI.create(value.trim());
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null
                || uri.getRawQuery() != null || uri.getRawFragment() != null
                || !(uri.getPath().isEmpty() || uri.getPath().equals("/"))) {
            throw new IllegalArgumentException("Нужен HTTPS-адрес сервера без пути.");
        }
        return "https://" + uri.getRawAuthority();
    }
    static boolean lamoda(String value) {
        try {
            URI uri = URI.create(value);
            return "https".equals(uri.getScheme()) && uri.getUserInfo() == null && uri.getPort() == -1
                    && ("www.lamoda.ru".equals(uri.getHost()) || "lamoda.ru".equals(uri.getHost()));
        } catch (RuntimeException error) { return false; }
    }
}
