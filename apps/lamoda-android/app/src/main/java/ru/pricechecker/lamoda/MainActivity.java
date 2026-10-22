package ru.pricechecker.lamoda;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
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

public class MainActivity extends Activity {
    private static final String WISHLIST = "https://www.lamoda.ru/wishlist/";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private WebView web;
    private TextView status;
    private TokenVault vault;
    private JSONObject job, pendingUpload;
    private boolean busy, resumed, autoReadOnLoad, pageReady, resumedOnce;
    private long readStarted;
    private int generation;
    private String collector;
    private Button collect;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved); vault = new TokenVault(this);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE); root.setFitsSystemWindows(true);
        root.setPadding(dp(12), dp(8), dp(12), 0);
        TextView title = new TextView(this); title.setText("Lamoda Collector"); title.setTextSize(22); title.setTextColor(Color.rgb(20,45,40));
        root.addView(title);
        LinearLayout actions = new LinearLayout(this);
        actions.addView(button("Подключение", this::connection), new LinearLayout.LayoutParams(0, dp(48), 1));
        collect = button("Собрать сейчас", this::requestJob);
        actions.addView(collect, new LinearLayout.LayoutParams(0, dp(48), 1));
        root.addView(actions);
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
                pageReady = false;
                if (job != null && !busy) autoReadOnLoad = true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                if (AddressPolicy.lamoda(request.getUrl().toString())) return false;
                message("В этом окне доступны только защищённые страницы Lamoda."); return true;
            }
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                pageReady = AddressPolicy.lamoda(url);
                if (autoReadOnLoad && AddressPolicy.lamoda(url) && !busy) { autoReadOnLoad = false; continueCollect(); }
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
        setBusy(false); screenAwake(false);
        String text = error.getMessage();
        message(text == null ? "Не удалось выполнить действие. Проверьте сеть и повторите." : text);
    }
    private void connection() {
        if (busy) { message("Дождитесь завершения текущего действия."); return; }
        new AlertDialog.Builder(this).setTitle("Подключение к VPS")
                .setMessage("В личном Telegram-боте выберите /lamoda_android и нажмите «Подключить телефон». Вводить код и адрес не нужно.\n\nЕсли телефон уже подключён, просто откройте приложение — сбор начнётся автоматически. Вход Lamoda остаётся на телефоне.")
                .setPositiveButton("Понятно",null)
                .setNeutralButton("Забыть подключение",(unused,which) -> { generation++; vault.clear(); job = null; pendingUpload = null; autoReadOnLoad = false; screenAwake(false); message("Подключение удалено с телефона. Для отзыва доступа используйте сайт."); }).show();
    }
    private void open(Intent intent) {
        if (busy) {
            if (intent != null && intent.getData() != null) {
                intent.setData(null);
                message("Сбор уже выполняется. Для нового подключения откройте ссылку после его завершения.");
            }
            return;
        }
        try {
            String pairing = intent != null && intent.getData() != null ? AddressPolicy.invitation(intent.getData().toString()) : "";
            // Consume the invitation once, including across activity recreation. Never accept a server override from a link.
            if (intent != null) intent.setData(null);
            generation++;
            pageReady = false; web.loadUrl(WISHLIST);
            if (pairing.isEmpty()) { requestJob(); return; }
            job = null; pendingUpload = null; setBusy(true); message("Подключаем телефон к VPS…");
            String origin = server();
            api(client -> new ServerApi(origin,"").call("pair",new JSONObject().put("code",pairing).put("name",Build.MANUFACTURER + " " + Build.MODEL)),result -> {
                String token = result.getString("token");
                if (!token.matches("[A-Za-z0-9_-]{43}")) throw new IllegalStateException("Неожиданный ответ сервера.");
                vault.save(token); setBusy(false); requestJob();
            });
        } catch (Exception error) { failure(error); }
    }
    private void requestJob() {
        if (busy) return;
        try { if (vault.read().isEmpty()) { message("Подключите телефон кнопкой в личном Telegram-боте: /lamoda_android. Ничего вводить в приложении не нужно."); return; } }
        catch (Exception error) { failure(error); return; }
        setBusy(true); message("Начинаем обновление избранного…");
        api(client -> client.call("start",new JSONObject()),result -> {
            setBusy(false);
            JSONObject next = result.optJSONObject("job");
            if (next == null) { job = null; pendingUpload = null; screenAwake(false); message("Сбор пока не начался. Повторите кнопкой «Собрать сейчас»."); return; }
            if (job == null || !job.optString("id").equals(next.optString("id"))) pendingUpload = null;
            job = next; screenAwake(true);
            autoReadOnLoad = true;
            if (pageReady && AddressPolicy.lamoda(web.getUrl())) { autoReadOnLoad = false; continueCollect(); }
            else if (!AddressPolicy.lamoda(web.getUrl())) web.loadUrl(WISHLIST);
        });
    }
    private void continueCollect() {
        if (busy) return;
        if (job == null) { requestJob(); return; }
        if (job.optLong("expires") <= System.currentTimeMillis()) { job = null; pendingUpload = null; requestJob(); return; }
        if (pendingUpload != null) { setBusy(true); upload(); return; }
        if (!AddressPolicy.lamoda(web.getUrl())) { message("Сначала откройте Lamoda и войдите в аккаунт."); return; }
        if (!pageReady) { autoReadOnLoad = true; message("Ждём загрузки избранного…"); return; }
        autoReadOnLoad = false;
        setBusy(true); screenAwake(true); readStarted = System.currentTimeMillis();
        int page = job.optInt("next_page",1);
        message("Читаем страницу избранного " + page + "… Не закрывайте приложение.");
        String script = collector + "\nglobalThis.__pcMobileResult={pending:true};globalThis.__priceCheckerReadPage("+page+").then(value=>{globalThis.__pcMobileResult=value;},()=>{globalThis.__pcMobileResult={error:'account_unverified'};});";
        web.evaluateJavascript(script,ignored -> handler.postDelayed(this::poll,600));
    }
    private void poll() {
        if (isDestroyed() || !busy || job == null) return;
        if (!resumed) { handler.postDelayed(this::poll,1000); return; }
        if (!AddressPolicy.lamoda(web.getUrl()) || System.currentTimeMillis()-readStarted > 75000) { setBusy(false); message("Страница изменилась или не отвечает. Откройте Lamoda и повторите сбор."); return; }
        web.evaluateJavascript("JSON.stringify(globalThis.__pcMobileResult || {pending:true})",value -> {
            if (isDestroyed() || !busy || job == null) return;
            try {
                Object decoded = new JSONTokener(value).nextValue();
                if (!(decoded instanceof String)) throw new IllegalStateException("Страница не вернула данные.");
                JSONObject result = new JSONObject((String) decoded);
                if (result.optBoolean("pending")) { handler.postDelayed(this::poll,600); return; }
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
        super.onResume(); resumed = true; if (web != null) web.onResume();
        // Let a Telegram onNewIntent take priority over the ordinary foreground refresh.
        if (resumedOnce && !busy && job == null) {
            int current = generation;
            handler.postDelayed(() -> { if (resumed && !isDestroyed() && current == generation && !busy && job == null) open(getIntent()); },300);
        }
        resumedOnce = true;
    }
    @Override protected void onPause() { resumed = false; CookieManager.getInstance().flush(); if (web != null) web.onPause(); super.onPause(); }
    @Override protected void onDestroy() { generation++; handler.removeCallbacksAndMessages(null); network.shutdownNow(); if (web != null) web.destroy(); super.onDestroy(); }
    @Override public void onBackPressed() { if (!busy && web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
