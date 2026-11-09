package ru.pricechecker.lamoda;

// Independent of Android so document freshness, cancellation and deadlines can be tested on the JVM.
final class ReadSession {
    private int version, firstDocument;
    private boolean active;
    private long started;
    int begin(long now, int document) {
        version++; active = true; started = now; firstDocument = document+1; return version;
    }
    boolean current(int id) { return active && version == id; }
    boolean active() { return active; }
    boolean canInspect(int id,int document) { return current(id) && document >= firstDocument; }
    boolean invalidate() { boolean wasActive = active; active = false; version++; return wasActive; }
    boolean timedOut(long now) {
        // Challenge redirects and background time never extend this deadline.
        return active && now-started > 75000;
    }
}
