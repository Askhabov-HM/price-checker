package ru.pricechecker.lamoda;

// Independent of Android so lifecycle races and active-time deadlines can be tested on the JVM.
final class ReadSession {
    private int version;
    private boolean active, paused;
    private long started, pausedAt, pausedTotal;
    int begin(long now, boolean foreground) {
        version++; active = true; started = now; pausedTotal = 0;
        paused = !foreground; pausedAt = now; return version;
    }
    boolean current(int id) { return active && version == id; }
    boolean invalidate() { boolean wasActive = active; active = false; version++; return wasActive; }
    void pause(long now) { if (active && !paused) { paused = true; pausedAt = now; } }
    void resume(long now) { if (active && paused) { pausedTotal += Math.max(0,now-pausedAt); paused = false; } }
    boolean timedOut(long now) {
        long end = paused ? pausedAt : now;
        return active && end-started-pausedTotal > 75000;
    }
}
