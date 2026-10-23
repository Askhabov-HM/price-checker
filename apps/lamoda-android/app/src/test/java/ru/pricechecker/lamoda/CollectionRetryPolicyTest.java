package ru.pricechecker.lamoda;

import org.junit.Test;
import static org.junit.Assert.*;

public class CollectionRetryPolicyTest {
    @Test public void transientSourceFailuresResumeWorkWithoutRequiringPush() {
        for (String code : new String[]{"access_limited","account_unverified","invalid_data","incomplete_data","rate_limited"}) {
            assertTrue(CollectionRetryPolicy.retrySource(code,0));
            assertFalse(CollectionRetryPolicy.retrySource(code,60000));
        }
        for (String code : new String[]{"login_required","account_mismatch","interrupted"})
            assertFalse(CollectionRetryPolicy.retrySource(code,0));
    }
    @Test public void aRetriedWorkerCanAcceptTheReplacementServerJob() {
        String original = "0123456789abcdef0123456789abcdef";
        assertEquals(original,CollectionRetryPolicy.expectedJob(0,original));
        assertNull(CollectionRetryPolicy.expectedJob(1,original));
        assertNull(CollectionRetryPolicy.expectedJob(3,original));
    }
}
