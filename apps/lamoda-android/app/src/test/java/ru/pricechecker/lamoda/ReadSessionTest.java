package ru.pricechecker.lamoda;

import org.junit.Test;
import static org.junit.Assert.*;

public class ReadSessionTest {
    @Test public void navigationAndNewReadsRejectCallbacksFromThePreviousDocument() {
        ReadSession state = new ReadSession();
        int old = state.begin(100,4);
        assertTrue(state.invalidate()); assertFalse(state.current(old));
        int next = state.begin(200,5);
        assertFalse(state.current(old)); assertTrue(state.current(next));
        int replacement = state.begin(300,6);
        assertFalse(state.current(next)); assertTrue(state.current(replacement));
    }
    @Test public void thePreviouslyLoadedDocumentCannotBeReusedByANewCollection() {
        ReadSession state=new ReadSession();int id=state.begin(100,8);
        assertFalse(state.canInspect(id,8));assertFalse(state.canInspect(id,7));
        assertTrue(state.canInspect(id,9));
        state.invalidate();assertFalse(state.canInspect(id,9));
    }
    @Test public void challengeRedirectsStayInOneReadAndCannotExtendItsDeadline() {
        ReadSession state=new ReadSession();int id=state.begin(100,0);
        for(int document=1;document<=10;document++)assertTrue(state.canInspect(id,document));
        assertFalse(state.timedOut(75100));assertTrue(state.timedOut(75101));
        assertTrue(state.current(id));state.invalidate();assertFalse(state.active());assertFalse(state.timedOut(999999));
    }
    @Test public void aDelayedCallbackCannotUploadAfterTheNextPageStarts() {
        ReadSession state=new ReadSession();int first=state.begin(100,0);
        assertTrue(state.canInspect(first,1));state.invalidate();
        int next=state.begin(500,1);
        assertFalse(state.canInspect(first,2));assertFalse(state.canInspect(next,1));assertTrue(state.canInspect(next,2));
    }
}
