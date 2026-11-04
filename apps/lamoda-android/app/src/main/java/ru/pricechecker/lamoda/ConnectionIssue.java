package ru.pricechecker.lamoda;

import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.security.GeneralSecurityException;
import javax.net.ssl.SSLException;

// Never display exception messages: URLs, invitations or credentials can occur in them.
final class ConnectionIssue {
    enum Kind { LINK, AUTH, BUSY, HTTP, REDIRECT, RESPONSE, DNS, TIMEOUT, TLS, CONNECT, NETWORK, STORAGE, UNKNOWN }
    private ConnectionIssue() {}
    static Kind kind(Throwable error, int status, boolean pairing) {
        if (status == 400 && pairing) return Kind.LINK;
        if (status == 401) return Kind.AUTH;
        if (status == 429 || status == 503) return Kind.BUSY;
        if (status >= 300 && status < 400) return Kind.REDIRECT;
        if (status >= 200 && status < 300) return Kind.RESPONSE;
        if (status > 0) return Kind.HTTP;
        // Bound traversal even for malformed/cyclic exception chains.
        Throwable cause = error;
        for (int depth = 0; cause != null && depth < 8; depth++, cause = cause.getCause()) {
            if (cause instanceof SSLException) return Kind.TLS;
            if (cause instanceof UnknownHostException) return Kind.DNS;
            if (cause instanceof SocketTimeoutException) return Kind.TIMEOUT;
            if (cause instanceof ConnectException) return Kind.CONNECT;
            if (cause instanceof GeneralSecurityException) return Kind.STORAGE;
        }
        return error instanceof IOException ? Kind.NETWORK : Kind.UNKNOWN;
    }
    static String message(Kind kind) {
        switch (kind) {
            case LINK: return "Ссылка истекла или уже использована. Получите новую: /lamoda_android.";
            case AUTH: return "VPS отклонил токен телефона. Подключите телефон заново через /lamoda_android.";
            case BUSY: return "VPS временно занят или ограничил запросы. Повторите позже.";
            case HTTP: return "VPS вернул ошибку HTTP. Подробности — в диагностике.";
            case REDIRECT: return "VPS перенаправляет запрос. Проверьте адрес сервера.";
            case RESPONSE: return "VPS вернул неожиданный ответ. Проверьте адрес и версию серверной части.";
            case DNS: return "Не удалось определить адрес VPS. Проверьте сеть и DNS.";
            case TIMEOUT: return "VPS не ответил вовремя. Проверьте соединение и повторите позже.";
            case TLS: return "Не удалось проверить защищённое соединение с VPS. Проверьте дату телефона и сертификат сервера.";
            case CONNECT: return "Не удалось установить соединение с VPS. Проверьте сеть и доступность сервера.";
            case NETWORK: return "Соединение с VPS прервано. Повторите после восстановления сети.";
            case STORAGE: return "Не удалось прочитать или сохранить токен в защищённом хранилище телефона.";
            default: return "Не удалось обработать подключение. Откройте диагностику и повторите попытку.";
        }
    }
}
