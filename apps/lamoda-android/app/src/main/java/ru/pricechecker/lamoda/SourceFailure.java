package ru.pricechecker.lamoda;

// Fixed source diagnostics only. Never retain website text, URLs or exception messages.
final class SourceFailure {
    private SourceFailure(){}
    static String message(String reason) {
        switch(reason) {
            case "redirect":return "Lamoda перенаправляет запрос избранного.";
            case "http_error":return "Lamoda вернула HTTP-ошибку.";
            case "content_type":return "Ответ Lamoda имеет неожиданный тип.";
            case "request_failed":return "Запрос избранного не выполнен: сеть или блокировка запроса.";
            case "request_timeout":case "page_timeout":return "Истекло время чтения Lamoda.";
            case "read_canceled":return "Чтение Lamoda прервано.";
            case "response_read":return "Не удалось дочитать ответ Lamoda.";
            case "response_too_large":case "state_too_large":return "Ответ Lamoda превышает допустимый размер.";
            case "html_parse":return "Не удалось разобрать страницу Lamoda.";
            case "state_script_missing":return "В ответе нет ожидаемого блока данных Lamoda.";
            case "state_script_ambiguous":return "В ответе несколько блоков данных Lamoda.";
            case "user_state":return "Не удалось разобрать блок аккаунта Lamoda.";
            case "payload_state":case "state_shape":return "Не удалось разобрать данные избранного Lamoda.";
            case "customer_missing":return "В ответе нет подтверждения аккаунта Lamoda.";
            case "customer_null":return "Lamoda сообщила, что вход не выполнен.";
            case "page_navigation":case "context_lost":return "Страница Lamoda изменилась во время чтения.";
            case "native_result":return "Не удалось получить результат чтения из WebView.";
            default:return "";
        }
    }
    static boolean valid(Object value){return value instanceof String&&!message((String)value).isEmpty();}
}
