package ru.pricechecker.lamoda;

import android.app.ActivityManager;
import android.app.KeyguardManager;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.PowerManager;
import android.util.Log;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

final class CollectorDiagnostics {
    enum Event { APP_OPEN, LINK_RECEIVED, LINK_VALID, LINK_INVALID, PAIR_SAVED, PAIR_SAVE_FAILED, PAIR_FAILED,
        FORGOTTEN, WORK_REQUEST_MANUAL, WORK_REQUEST_PUSH, WORK_REQUEST_POLL, WORK_NO_TOKEN,
        WORK_STARTED, WORK_TICK, WORK_STALE, WORK_SUCCESS, WORK_RETRY, WORK_FAILED, WORK_STOPPED,
        FOREGROUND_DENIED, PUSH_RECEIVED, PUSH_EXPIRED, PUSH_REGISTERED, PUSH_REGISTRATION_FAILED,
        SOURCE_LOGIN_REQUIRED, SOURCE_ACCOUNT_MISMATCH, SOURCE_UNVERIFIED, SOURCE_ERROR, RENDERER_GONE }
    enum Phase { BEGIN, OK, ERROR }
    private CollectorDiagnostics() {}
    private static synchronized void append(Context context, String entry) {
        // Only enums, validated API actions and numeric status codes reach this journal.
        // Never pass a Throwable, Intent, URL, token, job ID or source document to Log.
        try {
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'",Locale.ROOT);
            format.setTimeZone(TimeZone.getTimeZone("UTC"));
            String line = format.format(new Date()) + " " + entry;
            android.content.SharedPreferences prefs = context.getSharedPreferences("diagnostics",0);
            String[] previous = prefs.getString("events","").split("\n");
            StringBuilder history = new StringBuilder();
            for (int i = Math.max(0,previous.length-79); i < previous.length; i++)
                if (!previous[i].isEmpty()) history.append(previous[i]).append('\n');
            prefs.edit().putString("events",history.append(line).toString()).apply();
            Log.i("LamodaCollector",line);
        } catch (RuntimeException ignored) { /* Diagnostics must not interrupt collection. */ }
    }
    static void event(Context context, Event event) {
        if (event != Event.PUSH_RECEIVED && event != Event.WORK_STARTED && event != Event.WORK_STOPPED) {
            append(context,event.name()); return;
        }
        try {
            PowerManager power = context.getSystemService(PowerManager.class);
            append(context,event.name() + " locked=" + context.getSystemService(KeyguardManager.class).isDeviceLocked()
                    + " screen_off=" + !power.isInteractive() + " idle=" + power.isDeviceIdleMode()
                    + " battery_saver=" + power.isPowerSaveMode());
        } catch (RuntimeException ignored) { append(context,event.name()); }
    }
    static void api(Context context, String action, Phase phase, int status, ConnectionIssue.Kind issue) {
        if (!action.matches("pair|next|start|page|fail|push|stop")) return;
        append(context,"API " + action + " " + phase.name() + " HTTP=" + status + (issue == null ? "" : " " + issue.name()));
    }
    static String failure(Exception error, boolean pairing) {
        int status = error instanceof ServerApi.ApiException ? ((ServerApi.ApiException)error).status : 0;
        return ConnectionIssue.message(ConnectionIssue.kind(error,status,pairing));
    }
    static String report(Context context) {
        String server;
        try { server = AddressPolicy.server(context.getSharedPreferences("connection",0).getString("server",BuildConfig.DEFAULT_SERVER)); }
        catch (RuntimeException error) { server = "некорректный адрес"; }
        PowerManager power = context.getSystemService(PowerManager.class);
        ConnectivityManager network = context.getSystemService(ConnectivityManager.class);
        NetworkCapabilities capabilities = network.getNetworkCapabilities(network.getActiveNetwork());
        boolean connected = !context.getSharedPreferences("connection",0).getString("token","").isEmpty();
        return "Lamoda Collector " + BuildConfig.VERSION_NAME + " / diagnostics=1\n"
                + "VPS: " + server + "\nПодключение сохранено: " + connected
                + "\nСеть проверена Android: " + (capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
                + "\nDoze: " + power.isDeviceIdleMode() + "\nЭнергосбережение: " + power.isPowerSaveMode()
                + "\nБез оптимизации батареи: " + power.isIgnoringBatteryOptimizations(context.getPackageName())
                + "\nФон ограничен Android: " + (android.os.Build.VERSION.SDK_INT >= 28 && context.getSystemService(ActivityManager.class).isBackgroundRestricted())
                + "\nУведомления разрешены: " + ReminderService.allowed(context)
                + "\n\nПоследние события (UTC):\n" + context.getSharedPreferences("diagnostics",0).getString("events","Событий пока нет.");
    }
}
