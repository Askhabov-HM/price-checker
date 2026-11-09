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
import android.webkit.WebResourceError;
import android.webkit.WebResourceResponse;
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
    private String collector, owner, runId, text = "Войдите в Lamoda. Вход сохраняется на телефоне.";
    private CollectorDiagnostics.Stage stage=CollectorDiagnostics.Stage.waiting;
    private final Runnable heartbeat=new Runnable(){@Override public void run(){if(owner==null)return;progress(CollectorDiagnostics.Event.HEARTBEAT);main.postDelayed(this,30000);}};
    private JSONObject job, pendingUpload;
    private CompletableFuture<Boolean> completion;
    private boolean pageReady, busy, visible;
    private volatile int generation;
    private int document;
    private String lastSourceReason;

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
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true); settings.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        // Never expose a native bridge, device bearer token or server-supplied scripts to a website.
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                document++; pageReady = false;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return request.isForMainFrame() && !AddressPolicy.lamoda(request.getUrl().toString());
            }
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                pageReady = AddressPolicy.lamoda(url) && url.equals(view.getUrl());
            }
            @Override public void onReceivedHttpError(WebView view,WebResourceRequest request,WebResourceResponse response) {
                if(!sourceRequest(request))return;
                String retry=null;
                if(response.getResponseHeaders()!=null)for(java.util.Map.Entry<String,String> header:response.getResponseHeaders().entrySet())
                    if("Retry-After".equalsIgnoreCase(header.getKey()))retry=header.getValue();
                failSource(response.getStatusCode()==429?"rate_limited":"access_limited","http_error",response.getStatusCode(),SourceHttp.retryAfter(retry,System.currentTimeMillis()));
            }
            @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error) {
                if(sourceRequest(request))failNative("request_failed");
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                CollectorDiagnostics.event(context,CollectorDiagnostics.Event.RENDERER_GONE);
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
    private void publish() { if (listener != null) listener.changed(text,running(),owner != null || CollectorStore.get(context).active()!=null); }
    private void progress(CollectorDiagnostics.Event event){CollectorDiagnostics.progress(context,event,runId,job==null?null:job.optString("id"),job==null?0:job.optInt("next_page",1),stage);}
    void start(String id,String run,boolean manual,String expected,CompletableFuture<Boolean> done) {
        if (owner != null) { done.complete(true); return; }
        owner = id;runId=run;completion = done; generation++; busy = true; web.onResume();
        stage=CollectorDiagnostics.Stage.requesting;progress(CollectorDiagnostics.Event.PROGRESS);main.removeCallbacks(heartbeat);main.postDelayed(heartbeat,30000);
        message("Получаем задание с VPS…");
        api(client -> {
            client.requireProtocol();
            if(!CollectorStore.get(context).markSent(run))return new JSONObject().put("outcome","canceled");
            JSONObject request=new JSONObject().put("run_id",run);
            if(expected!=null&&!expected.isEmpty())request.put("expected_job",expected);
            return client.call(manual?"start":"next",request);
        },result -> {
            JSONObject next = result.optJSONObject("job");
            if (next == null || expected != null && !expected.isEmpty() && !expected.equals(next.optString("id"))) {
                String outcome=result.optString("outcome");
                finish(true,"canceled".equals(outcome)?"Запуск отменён на VPS.":"completed".equals(outcome)?"Сбор уже завершён и сохранён на VPS."
                        :"failed".equals(outcome)?"Сбор завершился ошибкой на VPS. Подробности доступны в журнале Android на сайте."
                        :"ended".equals(outcome)?"Задание VPS завершилось или было прервано. Для нового запуска нажмите «Собрать сейчас»."
                        :"Активного задания нет. Следующий сбор — по расписанию VPS.");return;
            }
            job = next;CollectorStore.get(context).bind(run,next.getString("id"));busy = false;publish();
            read();
        });
    }
    // Android interruptions retain the server job for a later worker. User Stop is separate.
    void release(String id) {
        if (id.equals(owner)) finish(false,"Фоновая задача прервана Android. Расписание сохранено.");
    }
    void stop() {
        String run=runId!=null?runId:CollectorStore.get(context).active();if(run==null)return;
        try {
            boolean remote=CollectionTasks.cancelCurrent(context,run);
            finish(true,remote?"Сбор остановлен на телефоне. Ожидаем подтверждение VPS; при отсутствии сети отмена сохранена.":"Ожидание запуска отменено на телефоне. Расписание сохранено.");
        } catch (Exception error) { message("Не удалось сохранить остановку. Повторите."); }
    }
    private void abortRead() {
        reads.invalidate();
        web.stopLoading();
    }
    private void finish(boolean success, String message) {
        stage=CollectorDiagnostics.Stage.finished;progress(CollectorDiagnostics.Event.PROGRESS);main.removeCallbacks(heartbeat);
        if(success && runId!=null)CollectorStore.get(context).finish(runId);
        generation++; abortRead(); busy = false; job = null; pendingUpload = null; owner = null;
        runId=null;
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
        boolean retry = !(error instanceof ServerApi.UpgradeRequired) && (!(error instanceof ServerApi.ApiException)
                || ((ServerApi.ApiException)error).status >= 500 || ((ServerApi.ApiException)error).retryable);
        finish(!retry,CollectorDiagnostics.failure(error,false) + (retry ? " Android повторит задачу в фоне." : ""));
    }
    private void read() {
        if (job == null || busy) return;
        if (job.optLong("expires") <= System.currentTimeMillis()) { finish(true,"Срок задания истёк. Расписание сохранено."); return; }
        busy = true; pageReady = false; lastSourceReason = "page_timeout";
        stage=CollectorDiagnostics.Stage.reading;progress(CollectorDiagnostics.Event.PROGRESS);
        int read = reads.begin(SystemClock.elapsedRealtime(),document), page = job.optInt("next_page",1);
        message("Открываем страницу избранного " + page + ". Сбор продолжится в фоне.");
        // Keep a deadline even if the renderer never returns an evaluation callback.
        main.postDelayed(() -> {
            if(job==null || !reads.current(read))return;
            if(job.optLong("expires")<=System.currentTimeMillis())finish(true,"Срок задания истёк. Расписание сохранено.");
            else failNative(lastSourceReason);
        },Math.min(75001,Math.max(1,job.optLong("expires")-System.currentTimeMillis())));
        web.loadUrl(AddressPolicy.wishlist(page));
        later(read);
    }
    private void later(int read) { main.postDelayed(() -> poll(read),600); }
    private boolean sourceRequest(WebResourceRequest request) {
        return job!=null && reads.active() && request.isForMainFrame()
                && AddressPolicy.lamoda(request.getUrl().toString()) && request.getUrl().toString().equals(web.getUrl());
    }
    private void poll(int read) {
        if (job == null || !reads.current(read)) return;
        if (job.optLong("expires") <= System.currentTimeMillis()) { finish(true,"Срок задания истёк. Расписание сохранено."); return; }
        if (reads.timedOut(SystemClock.elapsedRealtime())) { failNative(lastSourceReason); return; }
        if (!pageReady || !reads.canInspect(read,document)) { later(read); return; }
        int version=document, page=job.optInt("next_page",1);
        String script=collector+"\nJSON.stringify(globalThis.__priceCheckerReadPage("+page+"));";
        web.evaluateJavascript(script,value -> {
            if (job == null || !reads.current(read)) return;
            if (version!=document || !pageReady) { later(read); return; }
            try {
                Object decoded = new JSONTokener(value).nextValue();
                if (!(decoded instanceof String)) { failNative("native_result"); return; }
                JSONObject result = new JSONObject((String)decoded);
                if (result.optBoolean("pending")) {
                    String reason=result.optString("source_reason");
                    if(SourceFailure.valid(reason) && !reason.equals(lastSourceReason)) {
                        lastSourceReason=reason;
                        message("Ждём загрузки избранного и завершения проверки Lamoda. При необходимости откройте приложение и завершите проверку сайта.");
                    }
                    later(read); return;
                }
                reads.invalidate();
                if (!result.optString("error").isEmpty()) { fail(result.getString("error"),result); return; }
                pendingUpload = result.put("job_id",job.getString("id")).put("page",job.optInt("next_page",1));
                stage=CollectorDiagnostics.Stage.uploading;progress(CollectorDiagnostics.Event.PROGRESS);message("Передаём страницу серверу…");
                JSONObject body = pendingUpload;
                body.put("run_id",runId);
                api(client -> client.call("page",body),response -> {
                    pendingUpload = null; busy = false;
                    if (response.optBoolean("complete")) { finish(true,"Всё избранное передано VPS. Результат обработки придёт в Telegram."); return; }
                    job.put("next_page",response.getInt("next_page"));
                    stage=CollectorDiagnostics.Stage.waiting;progress(CollectorDiagnostics.Event.PROGRESS);
                    int current = generation;
                    main.postDelayed(() -> { if (current == generation && job != null) read(); },3000);
                });
            } catch (Exception error) { failNative("native_result"); }
        });
    }
    private void failNative(String reason) {
        failSource("account_unverified",reason,0,0);
    }
    private void failSource(String code,String reason,int status,long retryAfter) {
        try {fail(code,new JSONObject().put("source_reason",reason).put("http_status",status).put("retry_after_ms",retryAfter));}
        catch(Exception ignored){fail(code,null);}
    }
    private void fail(String code, JSONObject result) {
        CollectorDiagnostics.Event event="login_required".equals(code) ? CollectorDiagnostics.Event.SOURCE_LOGIN_REQUIRED
                : "account_mismatch".equals(code) ? CollectorDiagnostics.Event.SOURCE_ACCOUNT_MISMATCH
                : "account_unverified".equals(code) ? CollectorDiagnostics.Event.SOURCE_UNVERIFIED : CollectorDiagnostics.Event.SOURCE_ERROR;
        String reason=result==null?"":result.optString("source_reason");
        try {
            JSONObject fields=new JSONObject().put("stage","reading");
            if(SourceFailure.valid(reason))fields.put("source_reason",reason);
            int status=result==null?0:result.optInt("http_status");if(status>=0&&status<=599)fields.put("http_status",status);
            if(CollectorDiagnostics.id(runId))fields.put("run_id",runId);
            if(job!=null){fields.put("job_id",job.getString("id")).put("page",job.optInt("next_page",1));}
            CollectorDiagnostics.record(context,event,fields);
        }catch(Exception ignored){CollectorDiagnostics.event(context,event);}
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
                String detail=SourceFailure.message(reason);if(!detail.isEmpty())message=detail+" "+message;
                if (login && !visible) ReminderService.attention(context,message);
                finish(!retry,message);
            });
        } catch (Exception error) { networkFailure(error); }
    }
}
