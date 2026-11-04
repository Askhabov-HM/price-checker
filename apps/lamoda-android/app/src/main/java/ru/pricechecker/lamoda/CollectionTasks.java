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
    private static final String PERIODIC = "lamoda-scheduled-poll";
    static final String IMMEDIATE = "lamoda-collection";
    private static final Constraints NETWORK = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    private CollectionTasks() {}
    private static volatile boolean pairing;
    static boolean pairing(){return pairing;}
    static synchronized void pauseForPairing(Context context) {
        if(!preferences(context).edit().putLong("epoch",epoch(context)+1).commit())throw new IllegalStateException("Run storage failed");
        pairing=true;WorkManager.getInstance(context).cancelUniqueWork(IMMEDIATE);
    }
    static synchronized void finishPairing(Context context,boolean success) {
        try {
            if(success){CollectorStore.get(context).forget();preferences(context).edit().remove("stops").commit();WorkManager.getInstance(context).cancelUniqueWork("lamoda-stops");}
        }finally{pairing=false;}
        if(!success&&CollectorStore.get(context).active()!=null)request(context,false,null);
    }
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
        WorkManager.getInstance(context).enqueueUniquePeriodicWork("lamoda-diagnostics-poll",ExistingPeriodicWorkPolicy.KEEP,
                new PeriodicWorkRequest.Builder(DiagnosticsWorker.class,15,TimeUnit.MINUTES).setConstraints(NETWORK).build());
    }
    static synchronized void request(Context context, boolean manual, String expected) {
        request(context,manual,expected,false);
    }
    static synchronized void request(Context context, boolean manual, String expected, boolean expedited) {
        if(pairing)return;
        if (!connected(context)) { CollectorDiagnostics.event(context,CollectorDiagnostics.Event.WORK_NO_TOKEN); return; }
        CollectorDiagnostics.event(context,manual ? CollectorDiagnostics.Event.WORK_REQUEST_MANUAL
                : expected != null ? CollectorDiagnostics.Event.WORK_REQUEST_PUSH : CollectorDiagnostics.Event.WORK_REQUEST_POLL);
        schedule(context);
        CollectorStore store=CollectorStore.get(context);
        String run=store.begin(manual,expected,null);
        JSONObject saved;
        try {saved=store.run(run);} catch(Exception error){throw new IllegalStateException("Run storage failed",error);}
        boolean actualManual=saved.optBoolean("manual");String actualExpected=saved.optString("expected");
        Data input = new Data.Builder().putBoolean("manual",actualManual).putString("job",actualExpected).putString("run",run)
                .putLong("epoch",epoch(context)).build();
        OneTimeWorkRequest.Builder work = new OneTimeWorkRequest.Builder(CollectionWorker.class).setConstraints(NETWORK).setInputData(input).addTag("lamoda-run:"+run);
        if (expedited || actualManual) work.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST);
        WorkManager.getInstance(context).enqueueUniqueWork(IMMEDIATE,ExistingWorkPolicy.KEEP,work.build());
    }
    static void syncDiagnostics(Context context) {
        if(!connected(context))return;
        WorkManager.getInstance(context).enqueueUniqueWork("lamoda-diagnostics",ExistingWorkPolicy.KEEP,
                new OneTimeWorkRequest.Builder(DiagnosticsWorker.class).setConstraints(NETWORK).build());
    }
    static void retryStops(Context context) {
        if(!connected(context))return;
        WorkManager.getInstance(context).enqueueUniqueWork("lamoda-stops",ExistingWorkPolicy.APPEND_OR_REPLACE,
                new OneTimeWorkRequest.Builder(StopWorker.class).setConstraints(NETWORK).build());
    }
    static synchronized boolean cancelCurrent(Context context,String run) {
        boolean remote=CollectorStore.get(context).cancel(run);
        if(!preferences(context).edit().putLong("epoch",epoch(context)+1).commit())throw new IllegalStateException("Stop storage failed");
        WorkManager.getInstance(context).cancelUniqueWork(IMMEDIATE);
        CollectorDiagnostics.progress(context,CollectorDiagnostics.Event.CANCEL_REQUESTED,run,null,0,CollectorDiagnostics.Stage.canceling);
        if(remote){retryStops(context);CollectorDiagnostics.progress(context,CollectorDiagnostics.Event.CANCEL_PENDING,run,null,0,CollectorDiagnostics.Stage.canceling);}
        return remote;
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
        org.json.JSONArray cancellations=CollectorStore.get(context).cancellations();
        if (stops.isEmpty() && cancellations.length()==0) return;
        String token = new TokenVault(context).read();
        if (token.isEmpty()) return;
        String origin = context.getSharedPreferences("connection",0).getString("server",BuildConfig.DEFAULT_SERVER);
        ServerApi api = new ServerApi(origin,token,context);
        for (String id : new HashSet<>(stops)) {
            api.call("stop",new JSONObject().put("job_id",id));
            synchronized (CollectionTasks.class) {
                Set<String> remaining = new HashSet<>(prefs.getStringSet("stops",Collections.emptySet())); remaining.remove(id);
                if (!prefs.edit().putStringSet("stops",remaining).commit()) throw new IllegalStateException("Не удалось сохранить ответ сервера.");
            }
        }
        if(cancellations.length()>0)api.requireProtocol();
        for(int i=0;i<cancellations.length();i++) {
            JSONObject cancel=cancellations.getJSONObject(i),result=api.call("stop",cancel);
            String outcome=result.optString("outcome");
            if(!outcome.matches("canceled|completed|ended"))throw new IllegalStateException("Unexpected cancellation acknowledgement");
            CollectorStore.get(context).cancelAcknowledged(cancel.getString("run_id"),outcome);
            CollectorDiagnostics.record(context,CollectorDiagnostics.Event.CANCEL_ACK,new JSONObject().put("run_id",cancel.getString("run_id")).put("outcome",outcome));
        }
    }
    static synchronized void forget(Context context) {
        CollectorDiagnostics.event(context,CollectorDiagnostics.Event.FORGOTTEN);
        new TokenVault(context).clear();
        CollectorStore.get(context).forget();
        WorkManager manager = WorkManager.getInstance(context);
        manager.cancelUniqueWork(PERIODIC); manager.cancelUniqueWork(IMMEDIATE); manager.cancelUniqueWork("lamoda-stops");
        manager.cancelUniqueWork("lamoda-diagnostics-poll");manager.cancelUniqueWork("lamoda-diagnostics");
        preferences(context).edit().putLong("epoch",epoch(context)+1).remove("stops").apply();
    }
}
