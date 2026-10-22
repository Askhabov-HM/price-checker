package ru.pricechecker.lamoda;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.provider.Settings;
import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.RenderProcessGoneDetail;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import com.google.firebase.messaging.FirebaseMessaging;

public class MainActivity extends Activity {
    private static final String WISHLIST = "https://www.lamoda.ru/wishlist/";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private WebView web;
    private TextView status;
    private TokenVault vault;
    private JSONObject job, pendingUpload;
    private boolean busy, resumed, autoReadOnLoad, pageReady, resumedOnce;
    private final ReadSession reads = new ReadSession();
    private int generation, documentVersion, readRestarts, lastReadPage;
    private String lastReadJob = "";
    private String collector;
    private Button collect, notifications;
    private boolean reminderOnly;
    private String requestedReminder;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved); vault = new TokenVault(this);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE); root.setFitsSystemWindows(true);
        root.setPadding(dp(12), dp(8), dp(12), 0);
        TextView title = new TextView(this); title.setText("Lamoda Collector"); title.setTextSize(22); title.setTextColor(Color.rgb(20,45,40));
        root.addView(title);
        LinearLayout actions = new LinearLayout(this);
        actions.addView(button("Подключение", this::connection), new LinearLayout.LayoutParams(0, dp(48), 1));
        collect = button("Собрать сейчас", () -> { reminderOnly = false; requestedReminder = null; readRestarts = 0; requestJob(); });
        actions.addView(collect, new LinearLayout.LayoutParams(0, dp(48), 1));
        root.addView(actions);
        notifications = button("Уведомления",this::notificationSettings); root.addView(notifications);
        status = new TextView(this); status.setTextSize(14); status.setPadding(dp(4), dp(8), dp(4), dp(8));
        root.addView(status);
        web = new WebView(this); WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true); settings.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        // Do not expose addJavascriptInterface, tokens or arbitrary server scripts to Lamoda content.
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                documentVersion++; pageReady = false;
                if (reads.invalidate()) recoverRead();
                else if (job != null && !busy && readRestarts <= 2) autoReadOnLoad = true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                if (AddressPolicy.lamoda(request.getUrl().toString())) return false;
                message("В этом окне доступны только защищённые страницы Lamoda."); return true;
            }
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                pageReady = AddressPolicy.lamoda(url);
                resumeReadWhenReady();
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                view.destroy(); recreate(); return true;
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1)); setContentView(root);
        try (java.io.InputStream input = getAssets().open("collector.js")) {
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream(); byte[] bytes = new byte[4096]; int count;
            while ((count = input.read(bytes)) != -1) output.write(bytes,0,count);
            collector = output.toString(StandardCharsets.UTF_8.name());
        }
        catch (Exception error) { message("Не удалось загрузить сборщик. Переустановите приложение."); return; }
        message("Открываем избранное. Вход Lamoda сохраняется на телефоне.");
        open(getIntent());
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private Button button(String text, Runnable action) { Button button = new Button(this); button.setText(text); button.setAllCaps(false); button.setOnClickListener(view -> action.run()); return button; }
    private void message(String text) { if (status != null) status.setText(text); }
    private void resumeReadWhenReady() {
        if (!autoReadOnLoad || !pageReady || busy || !resumed) return;
        int document = documentVersion;
        handler.postDelayed(() -> {
            if (isDestroyed() || document != documentVersion || !autoReadOnLoad || !pageReady || busy || !resumed) return;
            web.evaluateJavascript("document.readyState",state -> {
                if (!isDestroyed() && document == documentVersion && autoReadOnLoad && pageReady && !busy && resumed && "\"complete\"".equals(state)) {
                    autoReadOnLoad = false; continueCollect();
                }
            });
        },350);
    }
    private void recoverRead() {
        setBusy(false); autoReadOnLoad = job != null && ++readRestarts <= 2;
        if (autoReadOnLoad) message("Страница обновилась. Продолжим сбор после её загрузки…");
        else { screenAwake(false); message("Lamoda несколько раз обновила страницу. Дождитесь её загрузки и нажмите «Собрать сейчас»."); }
    }
    private String server() { return getSharedPreferences("connection",0).getString("server", BuildConfig.DEFAULT_SERVER); }
    private void setBusy(boolean value) { busy = value; collect.setEnabled(!value); }
    private void screenAwake(boolean value) {
        if (value) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
    private interface Work { JSONObject run(ServerApi api) throws Exception; }
    private interface Done { void run(JSONObject value) throws Exception; }
    private void api(Work work, Done done) {
        int current = generation;
        network.execute(() -> {
            try {
                JSONObject value = work.run(new ServerApi(server(), vault.read()));
                handler.post(() -> {
                    if (isDestroyed() || current != generation) return;
                    try { done.run(value); } catch (Exception error) { failure(error); }
                });
            } catch (Exception error) { handler.post(() -> { if (!isDestroyed() && current == generation) failure(error); }); }
        });
    }
    private void failure(Exception error) {
        reads.invalidate(); setBusy(false); screenAwake(false);
        String text = error.getMessage();
        message(text == null ? "Не удалось выполнить действие. Проверьте сеть и повторите." : text);
    }
    private void connection() {
        if (busy) { message("Дождитесь завершения текущего действия."); return; }
        new AlertDialog.Builder(this).setTitle("Подключение к VPS")
                .setMessage("В личном Telegram-боте выберите /lamoda_android и нажмите «Подключить телефон». Вводить код и адрес не нужно.\n\nЕсли телефон уже подключён, просто откройте приложение — сбор начнётся автоматически. Вход Lamoda остаётся на телефоне.")
                .setPositiveButton("Понятно",null)
                .setNeutralButton("Забыть подключение",(unused,which) -> { generation++; vault.clear(); getSystemService(android.app.job.JobScheduler.class).cancel(1001); job = null; pendingUpload = null; autoReadOnLoad = false; screenAwake(false); message("Подключение удалено с телефона. Для отзыва доступа используйте сайт."); }).show();
    }
    private void notificationSettings() {
        if (!BuildConfig.FIREBASE_CONFIGURED) { message("Эта сборка без Firebase. Установите APK с настроенными уведомлениями."); return; }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && !getSharedPreferences("push",0).getBoolean("asked",false)) {
            getSharedPreferences("push",0).edit().putBoolean("asked",true).apply();
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},33); return;
        }
        startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,getPackageName()));
    }
    private void refreshPush() {
        boolean allowed = ReminderService.allowed(this);
        notifications.setText(!BuildConfig.FIREBASE_CONFIGURED ? "Уведомления: сборка без Firebase" : allowed ? "Уведомления разрешены" : "Разрешить уведомления");
        if (!BuildConfig.FIREBASE_CONFIGURED) return;
        try {
            FirebaseMessaging messaging = FirebaseMessaging.getInstance(); messaging.setAutoInitEnabled(true);
            messaging.setDeliveryMetricsExportToBigQuery(false);
            messaging.getToken().addOnCompleteListener(task -> {
                if (!task.isSuccessful()) {
                    if (!isDestroyed()) notifications.setText("Уведомления: нет связи с Google"); return;
                }
                getSharedPreferences("push",0).edit().putString("token",task.getResult()).apply(); PushRegistration.schedule(this);
            });
        } catch (IllegalStateException ignored) { notifications.setText("Уведомления: проверьте Firebase"); }
        if (Build.VERSION.SDK_INT >= 33 && !allowed && !getSharedPreferences("push",0).getBoolean("asked",false)) notificationSettings();
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request,permissions,results); if (request == 33) refreshPush();
    }
    private void open(Intent intent) {
        ReminderService.dismiss(this);
        if (busy) {
            if (intent != null && intent.getData() != null) {
                intent.setData(null);
                message("Сбор уже выполняется. Для нового подключения откройте ссылку после его завершения.");
            }
            return;
        }
        try {
            reminderOnly = intent != null && intent.hasExtra("lamoda_job"); requestedReminder = null;
            if (reminderOnly) {
                String id = intent.getStringExtra("lamoda_job"), expiry = intent.getStringExtra("lamoda_expires");
                intent.removeExtra("lamoda_job"); intent.removeExtra("lamoda_expires");
                if (!ReminderPolicy.valid(id,expiry,System.currentTimeMillis())) { message("Напоминание устарело. Для нового сбора нажмите «Собрать сейчас»."); return; }
                requestedReminder = id;
            }
            String pairing = intent != null && intent.getData() != null ? AddressPolicy.invitation(intent.getData().toString()) : "";
            // Consume the invitation once, including across activity recreation. Never accept a server override from a link.
            if (intent != null) intent.setData(null);
            generation++; reads.invalidate(); readRestarts = 0;
            pageReady = false; if (!reminderOnly) web.loadUrl(WISHLIST);
            if (pairing.isEmpty()) { requestJob(); return; }
            job = null; pendingUpload = null; setBusy(true); message("Подключаем телефон к VPS…");
            String origin = server();
            api(client -> new ServerApi(origin,"").call("pair",new JSONObject().put("code",pairing).put("name",Build.MANUFACTURER + " " + Build.MODEL)),result -> {
                String token = result.getString("token");
                if (!token.matches("[A-Za-z0-9_-]{43}")) throw new IllegalStateException("Неожиданный ответ сервера.");
                vault.save(token); PushRegistration.schedule(this); setBusy(false); requestJob();
            });
        } catch (Exception error) { failure(error); }
    }
    private void requestJob() {
        if (busy) return;
        try { if (vault.read().isEmpty()) { message("Подключите телефон кнопкой в личном Telegram-боте: /lamoda_android. Ничего вводить в приложении не нужно."); return; } }
        catch (Exception error) { failure(error); return; }
        setBusy(true); message("Начинаем обновление избранного…");
        String expected = requestedReminder;
        api(client -> client.call(expected == null ? "start" : "next",expected == null ? new JSONObject() : null),result -> {
            setBusy(false);
            JSONObject next = result.optJSONObject("job");
            if (expected != null && (next == null || !expected.equals(next.optString("id")))) {
                requestedReminder = null; job = null; pendingUpload = null; screenAwake(false);
                message("Этот сбор уже завершён или отменён. Для нового нажмите «Собрать сейчас»."); return;
            }
            requestedReminder = null;
            if (next == null) { job = null; pendingUpload = null; screenAwake(false); message("Сбор пока не начался. Повторите кнопкой «Собрать сейчас»."); return; }
            if (job == null || !job.optString("id").equals(next.optString("id"))) pendingUpload = null;
            job = next; screenAwake(true);
            autoReadOnLoad = true;
            if (pageReady && AddressPolicy.lamoda(web.getUrl())) resumeReadWhenReady();
            else if (!AddressPolicy.lamoda(web.getUrl())) web.loadUrl(WISHLIST);
        });
    }
    private void continueCollect() {
        if (busy) return;
        if (!resumed) { autoReadOnLoad = true; return; }
        if (job == null) { requestJob(); return; }
        if (job.optLong("expires") <= System.currentTimeMillis()) { job = null; pendingUpload = null; requestJob(); return; }
        if (pendingUpload != null) { setBusy(true); upload(); return; }
        if (!AddressPolicy.lamoda(web.getUrl())) { message("Сначала откройте Lamoda и войдите в аккаунт."); return; }
        if (!pageReady) { autoReadOnLoad = true; message("Ждём загрузки избранного…"); return; }
        autoReadOnLoad = false;
        setBusy(true); screenAwake(true);
        int page = job.optInt("next_page",1);
        String jobId = job.optString("id");
        if (!jobId.equals(lastReadJob) || page != lastReadPage) { readRestarts = 0; lastReadJob = jobId; lastReadPage = page; }
        int read = reads.begin(SystemClock.elapsedRealtime(),resumed);
        message("Читаем страницу избранного " + page + "… Не закрывайте приложение.");
        String script = collector + "\nglobalThis.__pcMobileReadId="+read+";globalThis.__pcMobileResult={pending:true};globalThis.__priceCheckerReadPage("+page+").then(value=>{if(globalThis.__pcMobileReadId==="+read+")globalThis.__pcMobileResult=value;},()=>{if(globalThis.__pcMobileReadId==="+read+")globalThis.__pcMobileResult={error:'account_unverified'};});";
        web.evaluateJavascript(script,ignored -> { if (reads.current(read)) handler.postDelayed(() -> poll(read),600); });
    }
    private void poll(int read) {
        if (isDestroyed() || !busy || job == null || !reads.current(read)) return;
        if (!resumed) { handler.postDelayed(() -> poll(read),1000); return; }
        if (!AddressPolicy.lamoda(web.getUrl()) || reads.timedOut(SystemClock.elapsedRealtime())) { reads.invalidate(); setBusy(false); screenAwake(false); message("Страница изменилась или не отвечает. Откройте Lamoda и повторите сбор."); return; }
        web.evaluateJavascript("JSON.stringify(globalThis.__pcMobileReadId === "+read+" ? globalThis.__pcMobileResult : {context_lost:true})",value -> {
            if (isDestroyed() || !busy || job == null || !reads.current(read)) return;
            try {
                Object decoded = new JSONTokener(value).nextValue();
                if (!(decoded instanceof String)) throw new IllegalStateException("Страница не вернула данные.");
                JSONObject result = new JSONObject((String) decoded);
                if (result.optBoolean("context_lost")) { reads.invalidate(); recoverRead(); resumeReadWhenReady(); return; }
                if (result.optBoolean("pending")) { handler.postDelayed(() -> poll(read),600); return; }
                reads.invalidate();
                String error = result.optString("error");
                if (!error.isEmpty()) {
                    if (error.equals("login_required") || error.equals("account_unverified")) {
                        setBusy(false); autoReadOnLoad = true; message("Войдите в Lamoda или завершите проверку сайта. После перехода сбор продолжится автоматически. Если страница не обновилась, нажмите «Собрать сейчас»."); return;
                    }
                    JSONObject body = new JSONObject().put("job_id",job.getString("id")).put("code",error)
                            .put("http_status",result.optInt("http_status")).put("retry_after_ms",result.optLong("retry_after_ms"));
                    api(client -> client.call("fail",body),ignored -> { job = null; setBusy(false); screenAwake(false); message("Lamoda ограничила запрос. Ошибка передана серверу; пауза источника будет соблюдена."); }); return;
                }
                pendingUpload = result.put("job_id",job.getString("id")).put("page",job.optInt("next_page",1)); upload();
            } catch (Exception error) { failure(error); }
        });
    }
    private void upload() {
        if (pendingUpload == null) return;
        JSONObject body = pendingUpload; message("Передаём данные серверу…");
        api(client -> client.call("page",body),result -> {
            pendingUpload = null; setBusy(false);
            if (result.optBoolean("complete")) { job = null; screenAwake(false); message("Всё избранное передано серверу. Результат обработки придёт в Telegram."); }
            else { job.put("next_page",result.getInt("next_page")); handler.postDelayed(this::continueCollect,3000); }
        });
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); open(intent); }
    @Override protected void onResume() {
        super.onResume(); resumed = true; reads.resume(SystemClock.elapsedRealtime()); refreshPush(); if (web != null) web.onResume(); resumeReadWhenReady();
        // Let a Telegram onNewIntent take priority over the ordinary foreground refresh.
        if (resumedOnce && !busy && job == null && !reminderOnly) {
            int current = generation;
            handler.postDelayed(() -> { if (resumed && !isDestroyed() && current == generation && !busy && job == null) open(getIntent()); },300);
        }
        resumedOnce = true;
    }
    @Override protected void onPause() { reads.pause(SystemClock.elapsedRealtime()); resumed = false; CookieManager.getInstance().flush(); if (web != null) web.onPause(); super.onPause(); }
    @Override protected void onDestroy() { generation++; reads.invalidate(); handler.removeCallbacksAndMessages(null); network.shutdownNow(); if (web != null) web.destroy(); super.onDestroy(); }
    @Override public void onBackPressed() { if (!busy && web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
