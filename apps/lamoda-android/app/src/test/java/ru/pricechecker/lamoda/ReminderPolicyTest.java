package ru.pricechecker.lamoda;

import org.junit.Test;
import static org.junit.Assert.*;

public class ReminderPolicyTest {
    @Test public void onlyLiveBoundedJobInvitationsCanStartCollection() {
        long now = 1792620000000L;
        String id = "0123456789abcdef0123456789abcdef";
        assertTrue(ReminderPolicy.valid(id,Long.toString(now + 45 * 60000),now));
        assertFalse(ReminderPolicy.valid(id,Long.toString(now),now));
        assertFalse(ReminderPolicy.valid(id,Long.toString(now + 61 * 60000),now));
        assertFalse(ReminderPolicy.valid("https://untrusted.invalid/",Long.toString(now + 60000),now));
        assertFalse(ReminderPolicy.valid(id,"9999999999999999999999999",now));
        assertFalse(ReminderPolicy.valid(null,null,now));
    }
}
