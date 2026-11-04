package ru.pricechecker.lamoda;

import org.junit.Test;
import java.util.Arrays;
import java.util.Collections;
import static org.junit.Assert.*;

public class DiagnosticPolicyTest {
    @Test public void localJournalRejectsCredentialsAndUntrustedTextBeforePersistence() {
        for(String key:Arrays.asList("token","cookies","code","url","message","event_id","event"))assertFalse(DiagnosticSchema.valid(key,"synthetic-private"));
        assertFalse(DiagnosticSchema.valid("action","https://example.invalid/?token=synthetic"));
        assertFalse(DiagnosticSchema.valid("issue","synthetic-private"));
        assertTrue(DiagnosticSchema.valid("issue","TLS"));
        assertTrue(DiagnosticSchema.valid("job_id","0123456789abcdef0123456789abcdef"));
        assertFalse(DiagnosticSchema.valid("page",1001));assertFalse(DiagnosticSchema.valid("duration_ms",-1));
        assertTrue(DiagnosticSchema.valid("screen_locked",true));assertFalse(DiagnosticSchema.valid("screen_locked","true"));
    }
    @Test public void onlyAcknowledgedEventsFromTheSentBatchCanLeaveTheOutbox() {
        assertEquals(Collections.singleton("two"),DiagnosticDelivery.confirmed(Arrays.asList("one","two"),Arrays.asList("two","two","not-sent")));
        assertTrue(DiagnosticDelivery.confirmed(Arrays.asList("one","two"),Collections.singleton("not-sent")).isEmpty());
        assertEquals(Collections.singleton("one"),DiagnosticDelivery.confirmed(Collections.singleton("one"),Collections.singleton("one")));
    }
}
