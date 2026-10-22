package ru.pricechecker.lamoda;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import com.google.firebase.messaging.FirebaseMessaging;

public class MainActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private CollectionEngine engine;
    private TokenVault vault;
    private TextView status;
    private Button collect, stop, notifications;
    private boolean pairing;
    private final CollectionEngine.Listener listener = (text,running,canStop) -> {
        status.setText(text); collect.setEnabled(!running && !pairing); stop.setEnabled(canStop && !pairing);
    };
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved); vault = new TokenVault(this); engine = CollectionEngine.get(this);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE); root.setFitsSystemWindows(true); root.setPadding(dp(12),dp(8),dp(12),0);
        TextView title = new TextView(this); title.setText("Lamoda Collector"); title.setTextSize(22); root.addView(title);
        LinearLayout actions = new LinearLayout(this);
        actions.addView(button("Подключение",this::connection),new LinearLayout.LayoutParams(0,dp(48),1));
        collect = button("Собрать сейчас",() -> request(true,null));
        actions.addView(collect,new LinearLayout.LayoutParams(0,dp(48),1));
        stop = button("Стоп",engine::stop); stop.setEnabled(false);
        actions.addView(stop,new LinearLayout.LayoutParams(0,dp(48),1)); root.addView(actions);
        notifications = button("Уведомления",this::notificationSettings); root.addView(notifications);
        status = new TextView(this); status.setTextSize(14); status.setPadding(dp(4),dp(8),dp(4),dp(8)); root.addView(status);
        FrameLayout browser = new FrameLayout(this); root.addView(browser,new LinearLayout.LayoutParams(-1,0,1));
        setContentView(root); engine.attach(this,browser,listener); open(getIntent());
    }
    private int dp(int value) { return Math.round(value*getResources().getDisplayMetrics().density); }
    private Button button(String text, Runnable action) {
        Button button = new Button(this); button.setText(text); button.setAllCaps(false); button.setOnClickListener(view -> action.run()); return button;
    }
    private void request(boolean manual, String expected) {
        try {
            if (vault.read().isEmpty()) { engine.message("Подключите телефон через личного Telegram-бота: /lamoda_android."); return; }
            if (engine.running() || pairing) return;
            CollectionTasks.request(this,manual,expected);
            engine.message(manual ? "Сбор поставлен в очередь. Ждём доступной сети…" : "Проверяем задание VPS…");
        } catch (Exception error) { engine.message("Не удалось запустить сбор. Проверьте подключение телефона."); }
    }
    private void open(Intent intent) {
        ReminderService.dismiss(this);
        String invitation = intent != null && intent.getData() != null ? AddressPolicy.invitation(intent.getData().toString()) : "";
        if (intent != null) intent.setData(null);
        if (!invitation.isEmpty()) { pair(invitation); return; }
        String expected = null;
        if (intent != null && intent.hasExtra("lamoda_job")) {
            String id = intent.getStringExtra("lamoda_job"), expiry = intent.getStringExtra("lamoda_expires");
            intent.removeExtra("lamoda_job"); intent.removeExtra("lamoda_expires");
            if (!ReminderPolicy.valid(id,expiry,System.currentTimeMillis())) { engine.message("Напоминание устарело. Следующий сбор — по расписанию VPS."); return; }
            expected = id;
        }
        // Opening the app never creates an extra check outside the VPS schedule.
        request(false,expected);
    }
    private void pair(String invitation) {
        if (engine.running() || pairing) { engine.message("Сначала остановите текущий сбор, затем откройте ссылку подключения снова."); return; }
        pairing = true; collect.setEnabled(false); engine.message("Подключаем телефон к VPS…");
        String origin = getSharedPreferences("connection",0).getString("server",BuildConfig.DEFAULT_SERVER);
        network.execute(() -> {
            try {
                JSONObject result = new ServerApi(origin,"").call("pair",new JSONObject().put("code",invitation)
                        .put("name",Build.MANUFACTURER+" "+Build.MODEL));
                String token = result.getString("token");
                if (!token.matches("[A-Za-z0-9_-]{43}")) throw new IllegalStateException();
                vault.save(token);
                main.post(() -> {
                    pairing = false; CollectionTasks.schedule(getApplicationContext()); PushRegistration.schedule(getApplicationContext());
                    if (!isDestroyed()) request(true,null);
                });
            } catch (Exception error) { main.post(() -> {
                pairing = false;
                if (!isDestroyed()) { collect.setEnabled(true); engine.message("Не удалось подключить телефон. Получите новую ссылку в Telegram-боте."); }
            }); }
        });
    }
    private void connection() {
        if (engine.running() || pairing) { engine.message("Сначала остановите текущий сбор."); return; }
        new AlertDialog.Builder(this).setTitle("Подключение к VPS")
                .setMessage("В личном Telegram-боте выберите /lamoda_android и нажмите «Подключить телефон». Вход Lamoda сохраняется на телефоне.\n\nРасписание задаётся на VPS. «Стоп» отменяет только текущий сбор.")
                .setPositiveButton("Понятно",null)
                .setNeutralButton("Забыть подключение",(unused,which) -> {
                    CollectionTasks.forget(this); getSystemService(android.app.job.JobScheduler.class).cancel(1001);
                    engine.message("Подключение удалено с телефона. Для отзыва доступа используйте сайт.");
                }).show();
    }
    private void notificationSettings() {
        if (!BuildConfig.FIREBASE_CONFIGURED) { engine.message("Эта сборка без Firebase. Задания проверяются в фоне без push."); return; }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && !getSharedPreferences("push",0).getBoolean("asked",false)) {
            getSharedPreferences("push",0).edit().putBoolean("asked",true).apply();
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},33); return;
        }
        startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,getPackageName()));
    }
    private void refreshPush() {
        boolean allowed = ReminderService.allowed(this);
        notifications.setText(!BuildConfig.FIREBASE_CONFIGURED ? "Фон без push: проверка каждые 15 минут" : allowed ? "Уведомления разрешены" : "Разрешить уведомления");
        if (!BuildConfig.FIREBASE_CONFIGURED) return;
        try {
            FirebaseMessaging messaging = FirebaseMessaging.getInstance(); messaging.setAutoInitEnabled(true);
            messaging.setDeliveryMetricsExportToBigQuery(false);
            messaging.getToken().addOnCompleteListener(task -> {
                if (!task.isSuccessful()) { if (!isDestroyed()) notifications.setText("Уведомления: нет связи с Google"); return; }
                getSharedPreferences("push",0).edit().putString("token",task.getResult()).apply(); PushRegistration.schedule(this);
            });
        } catch (IllegalStateException ignored) { notifications.setText("Уведомления: проверьте Firebase"); }
        if (Build.VERSION.SDK_INT >= 33 && !allowed && !getSharedPreferences("push",0).getBoolean("asked",false)) notificationSettings();
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request,permissions,results); if (request == 33) refreshPush();
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); open(intent); }
    @Override protected void onResume() { super.onResume(); engine.visible(true); refreshPush(); }
    @Override protected void onPause() { engine.visible(false); super.onPause(); }
    @Override protected void onDestroy() { engine.detach(listener); network.shutdown(); super.onDestroy(); }
    @Override public void onBackPressed() { if (!engine.back()) super.onBackPressed(); }
}
