package ru.pricechecker.lamoda;

import java.net.URI;

final class AddressPolicy {
    static String invitation(String value) {
        URI uri = URI.create(value);
        if (!"pricechecker-lamoda".equals(uri.getScheme()) || !"collect".equals(uri.getRawAuthority())
                || !uri.getPath().isEmpty() || uri.getRawFragment() != null) {
            throw new IllegalArgumentException("Откройте ссылку подключения из личного бота.");
        }
        String query = uri.getRawQuery();
        if (query == null) return "";
        if (!query.matches("connect=[a-f0-9]{32}")) throw new IllegalArgumentException("Ссылка подключения повреждена.");
        return query.substring("connect=".length());
    }
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
