package ru.pricechecker.lamoda;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.HashSet;
import java.util.Set;
import java.util.Collections;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

final class CollectionTasks {
    private static final String PERIODIC = "lamoda-scheduled-poll", IMMEDIATE = "lamoda-collection";
    private static final Constraints NETWORK = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    private CollectionTasks() {}
    static SharedPreferences preferences(Context context) { return context.getSharedPreferences("collection",0); }
    static long epoch(Context context) { return preferences(context).getLong("epoch",0); }
    private static boolean connected(Context context) {
        return !context.getSharedPreferences("connection",0).getString("token","").isEmpty();
    }
    static synchronized void schedule(Context context) {
        if (!connected(context)) return;
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC,ExistingPeriodicWorkPolicy.KEEP,
                new PeriodicWorkRequest.Builder(CollectionWorker.class,15,TimeUnit.MINUTES).setConstraints(NETWORK)
                        .setInputData(new Data.Builder().putBoolean("tick",true).build()).setInitialDelay(15,TimeUnit.MINUTES).build());
    }
    static synchronized void request(Context context, boolean manual, String expected) {
        request(context,manual,expected,false);
    }
    static synchronized void request(Context context, boolean manual, String expected, boolean expedited) {
        if (!connected(context)) return;
        schedule(context);
        Data input = new Data.Builder().putBoolean("manual",manual).putString("job",expected == null ? "" : expected)
                .putLong("epoch",epoch(context)).build();
        OneTimeWorkRequest.Builder work = new OneTimeWorkRequest.Builder(CollectionWorker.class).setConstraints(NETWORK).setInputData(input);
        if (expedited) work.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST);
        WorkManager.getInstance(context).enqueueUniqueWork(IMMEDIATE,manual ? ExistingWorkPolicy.REPLACE : ExistingWorkPolicy.KEEP,work.build());
    }
    static synchronized void rememberStop(Context context, String id) {
        SharedPreferences prefs = preferences(context);
        Set<String> stops = new HashSet<>(prefs.getStringSet("stops",Collections.emptySet())); stops.add(id);
        // Persist before stopping the WebView, including if Android kills the process immediately afterwards.
        if (!prefs.edit().putStringSet("stops",stops).putLong("epoch",epoch(context)+1).commit())
            throw new IllegalStateException("Не удалось сохранить остановку. Повторите.");
        WorkManager.getInstance(context).cancelUniqueWork(IMMEDIATE);
        WorkManager.getInstance(context).enqueueUniqueWork("lamoda-stops",ExistingWorkPolicy.APPEND_OR_REPLACE,
                new OneTimeWorkRequest.Builder(StopWorker.class).setConstraints(NETWORK).build());
    }
    static void flushStops(Context context) throws Exception {
        SharedPreferences prefs = preferences(context);
        Set<String> stops;
        synchronized (CollectionTasks.class) { stops = new HashSet<>(prefs.getStringSet("stops",Collections.emptySet())); }
        if (stops.isEmpty()) return;
        String token = new TokenVault(context).read();
        if (token.isEmpty()) return;
        String origin = context.getSharedPreferences("connection",0).getString("server",BuildConfig.DEFAULT_SERVER);
        ServerApi api = new ServerApi(origin,token);
        for (String id : new HashSet<>(stops)) {
            api.call("stop",new JSONObject().put("job_id",id));
            synchronized (CollectionTasks.class) {
                Set<String> remaining = new HashSet<>(prefs.getStringSet("stops",Collections.emptySet())); remaining.remove(id);
                if (!prefs.edit().putStringSet("stops",remaining).commit()) throw new IllegalStateException("Не удалось сохранить ответ сервера.");
            }
        }
    }
    static synchronized void forget(Context context) {
        new TokenVault(context).clear();
        WorkManager manager = WorkManager.getInstance(context);
        manager.cancelUniqueWork(PERIODIC); manager.cancelUniqueWork(IMMEDIATE); manager.cancelUniqueWork("lamoda-stops");
        preferences(context).edit().putLong("epoch",epoch(context)+1).remove("stops").apply();
    }
}
