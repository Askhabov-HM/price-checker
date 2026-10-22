package ru.pricechecker.lamoda;

import org.junit.Test;
import static org.junit.Assert.*;

public class ReadSessionTest {
    @Test public void navigationAndNewReadsRejectCallbacksFromThePreviousDocument() {
        ReadSession state = new ReadSession();
        int old = state.begin(100,true);
        assertTrue(state.invalidate()); assertFalse(state.current(old));
        int next = state.begin(200,true);
        assertFalse(state.current(old)); assertTrue(state.current(next));
        int replacement = state.begin(300,true);
        assertFalse(state.current(next)); assertTrue(state.current(replacement));
    }
    @Test public void aBackgroundStayDoesNotConsumeTheReadDeadline() {
        ReadSession state = new ReadSession(); state.begin(100,true);
        state.pause(10100); state.pause(20100);
        assertFalse(state.timedOut(3600100));
        state.resume(3610100); state.resume(3620100);
        assertFalse(state.timedOut(3675100));
        assertTrue(state.timedOut(3675101));
    }
    @Test public void aReadStartedInTheBackgroundWaitsForForegroundTime() {
        ReadSession state = new ReadSession(); int id = state.begin(0,false);
        assertFalse(state.timedOut(100000)); state.resume(100000);
        assertFalse(state.timedOut(175000)); assertTrue(state.timedOut(175001));
        assertTrue(state.current(id)); state.invalidate(); assertFalse(state.timedOut(999999));
    }
}
