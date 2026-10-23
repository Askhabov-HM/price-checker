package ru.pricechecker.lamoda;

final class CollectionRetryPolicy {
    private CollectionRetryPolicy() {}
    static boolean retrySource(String code, long retryAfter) {
        return retryAfter <= 0 && !"login_required".equals(code) && !"account_mismatch".equals(code)
                && !"interrupted".equals(code);
    }
    static String expectedJob(int attempt, String original) {
        // The VPS creates a new job for each read attempt within the same check.
        return attempt == 0 ? original : null;
    }
}
