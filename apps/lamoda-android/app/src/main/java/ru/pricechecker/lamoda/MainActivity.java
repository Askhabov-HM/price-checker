package ru.pricechecker.lamoda;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.RenderProcessGoneDetail;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.ScrollView;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private WebView web;
    private TextView status;
    private TokenVault vault;
    private JSONObject job, pendingUpload;
    private boolean busy, resumed, autoReadOnLoad;
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
        actions.addView(button("Открыть Lamoda", () -> { if (!busy) web.loadUrl("https://www.lamoda.ru/"); }), new LinearLayout.LayoutParams(0, dp(48), 1));
        root.addView(actions);
        LinearLayout work = new LinearLayout(this);
        work.addView(button("Получить задание", () -> requestJob(true)), new LinearLayout.LayoutParams(0, dp(48), 1));
        collect = button("Продолжить сбор", this::continueCollect);
        work.addView(collect, new LinearLayout.LayoutParams(0, dp(48), 1)); root.addView(work);
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
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                if (AddressPolicy.lamoda(request.getUrl().toString())) return false;
                message("В этом окне доступны только защищённые страницы Lamoda."); return true;
            }
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
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
        message("Подключите сервер, войдите в Lamoda и получите задание. Cookies останутся на телефоне.");
        web.loadUrl("https://www.lamoda.ru/");
        handler.postDelayed(() -> requestJob(false), 1000);
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
        LinearLayout fields = new LinearLayout(this); fields.setOrientation(LinearLayout.VERTICAL); fields.setPadding(dp(20),0,dp(20),0);
        EditText url = new EditText(this); url.setHint("HTTPS-адрес сервера"); url.setSingleLine(true); url.setText(server()); fields.addView(url);
        EditText code = new EditText(this); code.setHint("Одноразовый код подключения"); code.setSingleLine(true);
        code.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS); fields.addView(code);
        TextView help = new TextView(this); help.setText("Код создаётся на сайте Price Checker: Lamoda → Android. Он действует 10 минут."); fields.addView(help);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("Подключение к серверу").setView(fields)
                .setNegativeButton("Закрыть",null).setPositiveButton("Подключить",null)
                .setNeutralButton("Забыть подключение",(unused,which) -> { generation++; vault.clear(); job = null; pendingUpload = null; screenAwake(false); message("Подключение удалено с телефона. Для отзыва доступа используйте сайт."); }).create();
        dialog.setOnShowListener(unused -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                String origin = AddressPolicy.server(url.getText().toString()),pairing = code.getText().toString().trim().toLowerCase(java.util.Locale.ROOT);
                if (!pairing.matches("[a-f0-9]{32}")) throw new IllegalArgumentException("Введите полный код из 32 символов.");
                generation++; job = null; pendingUpload = null; setBusy(true); message("Подключаем телефон…"); dialog.dismiss();
                int current = generation;
                network.execute(() -> {
                    try {
                        JSONObject body = new JSONObject().put("code",pairing).put("name",Build.MANUFACTURER + " " + Build.MODEL);
                        JSONObject result = new ServerApi(origin,"").call("pair",body);
                        String token = result.getString("token"); if (!token.matches("[A-Za-z0-9_-]{43}")) throw new IllegalStateException("Неожиданный ответ сервера.");
                        vault.save(token); getSharedPreferences("connection",0).edit().putString("server",origin).apply();
                        handler.post(() -> { if (!isDestroyed() && current == generation) { setBusy(false); message("Телефон подключён. Войдите в Lamoda, затем нажмите «Получить задание»."); } });
                    } catch (Exception error) { handler.post(() -> { if (!isDestroyed() && current == generation) failure(error); }); }
                });
            } catch (Exception error) { code.setError(error.getMessage()); }
        })); dialog.show();
    }
    private void requestJob(boolean create) {
        if (busy) return;
        try { if (vault.read().isEmpty()) { if (create) connection(); return; } }
        catch (Exception error) { failure(error); return; }
        setBusy(true); message("Получаем задание…");
        api(client -> client.call(create ? "start" : "next",create ? new JSONObject() : null),result -> {
            setBusy(false);
            JSONObject next = result.optJSONObject("job");
            if (next == null) { job = null; pendingUpload = null; screenAwake(false); message("Новых заданий нет. Нажмите «Получить задание», чтобы начать сбор."); return; }
            if (job == null || !job.optString("id").equals(next.optString("id"))) pendingUpload = null;
            job = next; screenAwake(true);
            message("Задание получено. Войдите в Lamoda; если появилась проверка, пройдите её и нажмите «Продолжить сбор».");
            if (AddressPolicy.lamoda(web.getUrl())) continueCollect();
            else { autoReadOnLoad = true; web.loadUrl("https://www.lamoda.ru/"); }
        });
    }
    private void continueCollect() {
        if (busy) return;
        if (job == null) { requestJob(true); return; }
        if (job.optLong("expires") <= System.currentTimeMillis()) { job = null; pendingUpload = null; screenAwake(false); message("Задание истекло. Получите новое задание."); return; }
        if (pendingUpload != null) { setBusy(true); upload(); return; }
        if (!AddressPolicy.lamoda(web.getUrl())) { message("Сначала откройте Lamoda и войдите в аккаунт."); return; }
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
                        setBusy(false); message("Войдите в Lamoda или завершите проверку сайта, затем нажмите «Продолжить сбор». Данные пока не отправлены."); return;
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
            else { job.put("next_page",result.getInt("next_page")); handler.postDelayed(this::continueCollect,1000); }
        });
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); requestJob(false); }
    @Override protected void onResume() { super.onResume(); resumed = true; if (web != null) web.onResume(); }
    @Override protected void onPause() { resumed = false; CookieManager.getInstance().flush(); if (web != null) web.onPause(); super.onPause(); }
    @Override protected void onDestroy() { generation++; handler.removeCallbacksAndMessages(null); network.shutdownNow(); if (web != null) web.destroy(); super.onDestroy(); }
    @Override public void onBackPressed() { if (!busy && web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
