package ru.pricechecker.lamoda;

import android.app.ActivityManager;
import android.app.Application;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;
import org.json.JSONObject;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

public final class CollectorApplication extends Application {
    private final Handler main=new Handler(Looper.getMainLooper());
    private final Map<String,String> states=new HashMap<>();
    @Override public void onCreate() {
        super.onCreate();CollectorDiagnostics.event(this,CollectorDiagnostics.Event.PROCESS_START);
        exits();
        // Passive timer: it acquires no wake lock and does not keep the process alive.
        main.postDelayed(new Runnable(){@Override public void run(){CollectorDiagnostics.event(CollectorApplication.this,CollectorDiagnostics.Event.PROCESS_ALIVE);main.postDelayed(this,60000);}},60000);
        observe(CollectionTasks.IMMEDIATE);observe("lamoda-scheduled-poll");
        CollectionTasks.schedule(this);CollectionTasks.syncDiagnostics(this);
        if(CollectorStore.get(this).pendingCancellation())CollectionTasks.retryStops(this);
    }
    private void observe(String name) {
        WorkManager.getInstance(this).getWorkInfosForUniqueWorkLiveData(name).observeForever(work -> {
            if(work==null)return;
            for(WorkInfo info:work) {
                int stopReason=Build.VERSION.SDK_INT>=31?info.getStopReason():-256;
                String key=info.getId().toString(),state=info.getState().name()+":"+info.getRunAttemptCount()+":"+stopReason;
                if(state.equals(states.put(key,state)))continue;
                try {
                    JSONObject fields=new JSONObject().put("work_state",info.getState().name()).put("attempt",info.getRunAttemptCount());
                    if(stopReason>=0)fields.put("stop_reason",stopReason);
                    for(String tag:info.getTags())if(tag.startsWith("lamoda-run:")&&CollectorDiagnostics.id(tag.substring(11)))fields.put("run_id",tag.substring(11));
                    long next=info.getNextScheduleTimeMillis();
                    if(next>0&&next<System.currentTimeMillis()+30L*86400000)fields.put("next_run_at",Instant.ofEpochMilli(next).toString());
                    CollectorDiagnostics.record(this,CollectorDiagnostics.Event.WORK_STATE,fields);
                }catch(Exception ignored){/* Only structured, non-secret fields are collected. */}
            }
        });
    }
    private void exits() {
        if(Build.VERSION.SDK_INT<30)return;
        try {
            CollectorStore store=CollectorStore.get(this);long previous=store.meta("last_exit"),latest=previous;
            for(android.app.ApplicationExitInfo exit:getSystemService(ActivityManager.class).getHistoricalProcessExitReasons(getPackageName(),0,5)) {
                if(exit.getTimestamp()<=previous)continue;
                CollectorDiagnostics.record(this,CollectorDiagnostics.Event.PROCESS_EXIT,new JSONObject().put("exit_reason",exit.getReason())
                        .put("exit_status",exit.getStatus()).put("importance",exit.getImportance()).put("exit_at",Instant.ofEpochMilli(exit.getTimestamp()).toString()));
                latest=Math.max(latest,exit.getTimestamp());
            }
            store.meta("last_exit",latest);
        }catch(Exception ignored){/* Exit history can be unavailable; never read traces/descriptions. */}
    }
}
