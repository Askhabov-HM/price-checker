package ru.pricechecker.lamoda;

import android.content.Context;
import android.content.MutableContextWrapper;
import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// Main-thread owner of the authenticated WebView. An Activity only displays it;
// WorkManager owns collection, including when the Activity is removed from recents.
final class CollectionEngine {
    interface Listener { void changed(String message, boolean running, boolean canStop); }
    private static final String WISHLIST = "https://www.lamoda.ru/wishlist/";
    private static CollectionEngine instance;
    static CollectionEngine get(Context context) {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Main thread required");
        if (instance == null) instance = new CollectionEngine(context.getApplicationContext());
        return instance;
    }
    static void releaseIfPresent(String id) { if (instance != null) instance.release(id); }
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final ReadSession reads = new ReadSession();
    private final MutableContextWrapper webContext;
    private WebView web;
    private Listener listener;
    private ViewGroup host;
    private String collector, owner, text = "Войдите в Lamoda. Вход сохраняется на телефоне.";
    private JSONObject job, pendingUpload;
    private CompletableFuture<Boolean> completion;
    private boolean pageReady, busy, visible;
    private volatile int generation;
    private int document, restarts;
    private long nextReadAt;

    private CollectionEngine(Context context) {
        this.context = context; webContext = new MutableContextWrapper(context);
        try (InputStream input = context.getAssets().open("collector.js")) {
            ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] bytes = new byte[4096]; int n;
            while ((n = input.read(bytes)) != -1) output.write(bytes,0,n);
            collector = output.toString(StandardCharsets.UTF_8.name());
        } catch (Exception error) { throw new IllegalStateException("Не удалось загрузить сборщик.",error); }
        createWebView();
    }
    private void createWebView() {
        web = new WebView(webContext); WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true); settings.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        // Never expose a native bridge, device bearer token or server-supplied scripts to a website.
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                document++; pageReady = false;
                if (reads.invalidate()) {
                    busy = false;
                    if (++restarts > 2) { fail("account_unverified",null); return; }
                    message("Страница обновилась. Ждём загрузки Lamoda…");
                }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return request.isForMainFrame() && !AddressPolicy.lamoda(request.getUrl().toString());
            }
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush(); pageReady = AddressPolicy.lamoda(url); ready();
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                if (view.getParent() instanceof ViewGroup) ((ViewGroup)view.getParent()).removeView(view);
                finish(false,"WebView остановлен Android. Повторим сбор при следующем запуске задачи.");
                view.destroy(); createWebView();
                if (host != null) host.addView(web,new ViewGroup.LayoutParams(-1,-1));
                web.loadUrl(WISHLIST); return true;
            }
        });
    }
    void attach(Context activity, ViewGroup container, Listener value) {
        if (web.getParent() instanceof ViewGroup) ((ViewGroup)web.getParent()).removeView(web);
        host = container; listener = value; webContext.setBaseContext(activity);
        container.addView(web,new ViewGroup.LayoutParams(-1,-1)); visible = true; web.onResume();
        if (web.getUrl() == null) web.loadUrl(WISHLIST);
        publish();
    }
    void detach(Listener value) {
        if (listener != value) return;
        listener = null; host = null; visible = false;
        if (web.getParent() instanceof ViewGroup) ((ViewGroup)web.getParent()).removeView(web);
        webContext.setBaseContext(context);
        if (owner == null) web.onPause();
    }
    void visible(boolean value) {
        visible = value;
        if (value || owner != null) web.onResume(); else web.onPause();
        CookieManager.getInstance().flush();
    }
    boolean running() { return owner != null; }
    boolean back() { if (!running() && web.canGoBack()) { web.goBack(); return true; } return false; }
    void message(String value) {
        text = value; publish();
    }
    private void publish() { if (listener != null) listener.changed(text,running(),job != null); }
    void start(String id, boolean manual, String expected, CompletableFuture<Boolean> done) {
        if (owner != null) { done.complete(true); return; }
        owner = id; completion = done; generation++; busy = true; restarts = 0; nextReadAt = 0; web.onResume();
        message("Получаем задание с VPS…");
        api(client -> client.call(manual ? "start" : "next",manual ? new JSONObject() : null),result -> {
            JSONObject next = result.optJSONObject("job");
            if (next == null || expected != null && !expected.isEmpty() && !expected.equals(next.optString("id"))) {
                finish(true,"Активного задания нет. Следующий сбор — по расписанию VPS."); return;
            }
            job = next; busy = false; publish();
            if (pageReady && AddressPolicy.lamoda(web.getUrl())) ready();
            else web.loadUrl(WISHLIST);
        });
    }
    // Android interruptions retain the server job for a later worker. User Stop is separate.
    void release(String id) {
        if (id.equals(owner)) finish(false,"Фоновая задача прервана Android. Расписание сохранено.");
    }
    void stop() {
        if (job == null) return;
        try {
            CollectionTasks.rememberStop(context,job.getString("id"));
            finish(true,"Текущий сбор остановлен. Следующий выполнится по расписанию.");
        } catch (Exception error) { message("Не удалось сохранить остановку. Повторите."); }
    }
    private void abortRead() {
        reads.invalidate();
        web.evaluateJavascript("globalThis.__pcMobileReadId=null;globalThis.__priceCheckerCancel?.();delete globalThis.__pcMobileResult;",null);
    }
    private void finish(boolean success, String message) {
        generation++; abortRead(); busy = false; job = null; pendingUpload = null; owner = null;
        CompletableFuture<Boolean> done = completion; completion = null;
        CookieManager.getInstance().flush(); ReminderService.dismissProgress(context);
        if (!visible) web.onPause();
        message(message); if (done != null) done.complete(success);
    }
    private interface Work { JSONObject run(ServerApi api) throws Exception; }
    private interface Done { void run(JSONObject value) throws Exception; }
    private void api(Work work, Done done) {
        int current = generation;
        network.execute(() -> {
            if (current != generation) return;
            try {
                String origin = context.getSharedPreferences("connection",0).getString("server",BuildConfig.DEFAULT_SERVER);
                JSONObject result = work.run(new ServerApi(origin,new TokenVault(context).read(),context));
                main.post(() -> {
                    if (current != generation || owner == null) return;
                    try { done.run(result); } catch (Exception error) { networkFailure(error); }
                });
            } catch (Exception error) { main.post(() -> { if (current == generation && owner != null) networkFailure(error); }); }
        });
    }
    private void networkFailure(Exception error) {
        boolean retry = !(error instanceof ServerApi.ApiException) || ((ServerApi.ApiException)error).status >= 500;
        finish(!retry,"Не удалось передать данные VPS. " + (retry ? "Повторим в фоне." : "Проверьте подключение телефона к серверу."));
    }
    private void ready() {
        if (owner == null || job == null || busy || !pageReady) return;
        int current = generation, version = document;
        main.postDelayed(() -> {
            if (current != generation || version != document || !pageReady || busy || job == null) return;
            web.evaluateJavascript("document.readyState",state -> {
                if (current == generation && version == document && !busy && job != null && "\"complete\"".equals(state)) read();
            });
        },Math.max(350,nextReadAt-SystemClock.elapsedRealtime()));
    }
    private void read() {
        if (job == null || busy) return;
        if (job.optLong("expires") <= System.currentTimeMillis()) { finish(true,"Срок задания истёк. Расписание сохранено."); return; }
        if (!pageReady || !AddressPolicy.lamoda(web.getUrl())) return;
        if (SystemClock.elapsedRealtime() < nextReadAt) { ready(); return; }
        busy = true;
        int read = reads.begin(SystemClock.elapsedRealtime(),true), page = job.optInt("next_page",1);
        message("Читаем страницу избранного " + page + ". Сбор продолжится в фоне.");
        String script = collector + "\nglobalThis.__pcMobileReadId="+read+";globalThis.__pcMobileResult={pending:true};globalThis.__priceCheckerReadPage("+page+").then(value=>{if(globalThis.__pcMobileReadId==="+read+")globalThis.__pcMobileResult=value;},()=>{if(globalThis.__pcMobileReadId==="+read+")globalThis.__pcMobileResult={error:'account_unverified'};});";
        web.evaluateJavascript(script,ignored -> { if (reads.current(read)) main.postDelayed(() -> poll(read),600); });
    }
    private void poll(int read) {
        if (job == null || !reads.current(read)) return;
        if (reads.timedOut(SystemClock.elapsedRealtime())) { fail("account_unverified",null); return; }
        web.evaluateJavascript("JSON.stringify(globalThis.__pcMobileReadId === "+read+" ? globalThis.__pcMobileResult : {context_lost:true})",value -> {
            if (job == null || !reads.current(read)) return;
            try {
                Object decoded = new JSONTokener(value).nextValue();
                if (!(decoded instanceof String)) { fail("account_unverified",null); return; }
                JSONObject result = new JSONObject((String)decoded);
                if (result.optBoolean("context_lost")) {
                    reads.invalidate(); busy = false;
                    if (++restarts > 2) fail("account_unverified",null); else ready(); return;
                }
                if (result.optBoolean("pending")) { main.postDelayed(() -> poll(read),600); return; }
                reads.invalidate();
                if (!result.optString("error").isEmpty()) { fail(result.getString("error"),result); return; }
                pendingUpload = result.put("job_id",job.getString("id")).put("page",job.optInt("next_page",1));
                message("Передаём страницу серверу…");
                JSONObject body = pendingUpload;
                api(client -> client.call("page",body),response -> {
                    pendingUpload = null; busy = false; restarts = 0;
                    if (response.optBoolean("complete")) { finish(true,"Всё избранное передано VPS. Результат обработки придёт в Telegram."); return; }
                    job.put("next_page",response.getInt("next_page"));
                    nextReadAt = SystemClock.elapsedRealtime()+3000;
                    int current = generation;
                    main.postDelayed(() -> { if (current == generation && job != null) read(); },3000);
                });
            } catch (Exception error) { fail("invalid_data",null); }
        });
    }
    private void fail(String code, JSONObject result) {
        if (job == null) { finish(false,"Страница Lamoda не загрузилась. Повторим в фоне."); return; }
        abortRead(); busy = true;
        try {
            JSONObject body = new JSONObject().put("job_id",job.getString("id")).put("code",code)
                    .put("http_status",result == null ? 0 : result.optInt("http_status"))
                    .put("retry_after_ms",result == null ? 0 : result.optLong("retry_after_ms"));
            boolean login = code.equals("login_required") || code.equals("account_mismatch");
            boolean retry = CollectionRetryPolicy.retrySource(code,result == null ? 0 : result.optLong("retry_after_ms"));
            api(client -> client.call("fail",body),ignored -> {
                String message = login ? "Откройте Lamoda, войдите или завершите проверку сайта. Затем нажмите «Собрать сейчас»."
                        : retry ? "Ошибка Lamoda. Повторим сбор в фоне."
                        : "Ошибка Lamoda передана VPS. Расписание и пауза источника сохранены.";
                if (login && !visible) ReminderService.attention(context,message);
                finish(!retry,message);
            });
        } catch (Exception error) { networkFailure(error); }
    }
}
