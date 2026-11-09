package ru.pricechecker.lamoda;

import org.junit.Test;
import java.time.Instant;
import static org.junit.Assert.*;

public class SourceHttpTest {
    @Test public void sourcePausesAcceptSecondsAndHttpDates() {
        long now=Instant.parse("2026-11-10T00:00:00Z").toEpochMilli();
        assertEquals(120000,SourceHttp.retryAfter("120",now));
        assertEquals(120000,SourceHttp.retryAfter("Tue, 10 Nov 2026 00:02:00 GMT",now));
        assertEquals(0,SourceHttp.retryAfter("Tue, 10 Nov 2026 00:00:00 GMT",now+1000));
        assertEquals(120000,SourceHttp.retryAfter(" 000120 ",now));
    }
    @Test public void malformedOrOverflowingSourceValuesCannotBreakCollection() {
        assertEquals(365L*86400000,SourceHttp.retryAfter("999999999999999999999999",0));
        assertEquals(365L*86400000,SourceHttp.retryAfter("99999999",0));
        for(String value:new String[]{"-1","1.5","NaN","private-source-text",""})assertEquals(0,SourceHttp.retryAfter(value,0));
        assertEquals(0,SourceHttp.retryAfter(null,0));
    }
}
