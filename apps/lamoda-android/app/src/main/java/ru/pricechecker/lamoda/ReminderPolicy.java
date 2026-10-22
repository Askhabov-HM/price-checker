package ru.pricechecker.lamoda;

final class ReminderPolicy {
    static boolean valid(String id, String expiry, long now) {
        if (id == null || !id.matches("[a-f0-9]{32}") || expiry == null || !expiry.matches("[0-9]{13}")) return false;
        long time = Long.parseLong(expiry);
        // Allow modest clock skew; the VPS also verifies the actual job before collection.
        return time > now && time - now <= 60 * 60 * 1000L;
    }
}
