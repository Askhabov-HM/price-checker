package ru.pricechecker.lamoda;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

// Durable, network-constrained registration retry; this never polls VPS for reminders.
public final class PushRegistration extends JobService {
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    static void schedule(Context context) {
        if (!BuildConfig.FIREBASE_CONFIGURED) return;
        context.getSystemService(JobScheduler.class).schedule(new JobInfo.Builder(1001,new ComponentName(context,PushRegistration.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setBackoffCriteria(30000,JobInfo.BACKOFF_POLICY_EXPONENTIAL).setPersisted(true).build());
    }
    @Override public boolean onStartJob(JobParameters params) {
        network.execute(() -> {
            boolean retry = false;
            try {
                String device = new TokenVault(this).read(), token = getSharedPreferences("push",0).getString("token","");
                if (!device.isEmpty() && !token.isEmpty()) {
                    String server = getSharedPreferences("connection",0).getString("server",BuildConfig.DEFAULT_SERVER);
                    new ServerApi(server,device).call("push",new JSONObject().put("token",token).put("enabled",ReminderService.allowed(this))
                            .put("project_id",getString(R.string.project_id)));
                    getSharedPreferences("push",0).edit().putBoolean("registered",true).apply();
                }
            } catch (ServerApi.ApiException error) {
                retry = error.status != 401 && error.status != 400;
                getSharedPreferences("push",0).edit().putBoolean("registered",false).apply();
            } catch (Exception ignored) { retry = true; }
            jobFinished(params,retry);
        });
        return true;
    }
    @Override public boolean onStopJob(JobParameters params) { return true; }
    @Override public void onDestroy() { network.shutdownNow(); super.onDestroy(); }
}
