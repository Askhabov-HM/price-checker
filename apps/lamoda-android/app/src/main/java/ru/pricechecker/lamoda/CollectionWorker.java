package ru.pricechecker.lamoda;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.NonNull;
import androidx.work.ForegroundInfo;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

public final class CollectionWorker extends Worker {
    private final Handler main = new Handler(Looper.getMainLooper());
    public CollectionWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context,params); }
    private ForegroundInfo foreground(Context context) {
        ReminderService.channel(context);
        PendingIntent open = PendingIntent.getActivity(context,2,new Intent(context,MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notice = new Notification.Builder(context,ReminderService.CHANNEL)
                .setSmallIcon(R.drawable.ic_notification).setContentTitle("Lamoda: проверяем избранное")
                .setContentText("Сбор продолжится при заблокированном экране.")
                .setContentIntent(open).setOngoing(true).build();
        return new ForegroundInfo(42,notice,ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    }
    @NonNull @Override public ForegroundInfo getForegroundInfo() { return foreground(getApplicationContext()); }
    @NonNull @Override public Result doWork() {
        Context context = getApplicationContext();
        // Periodic ticks, push and manual requests all use the same unique one-time queue.
        if (getInputData().getBoolean("tick",false)) {
            CollectionTasks.request(context,false,null); return Result.success();
        }
        CompletableFuture<Boolean> done = new CompletableFuture<>();
        try {
            if (isStopped() || new TokenVault(context).read().isEmpty()) return Result.success();
            CollectionTasks.flushStops(context);
            long epoch = getInputData().getLong("epoch",CollectionTasks.epoch(context));
            if (epoch != CollectionTasks.epoch(context)) return Result.success();
            try { setForegroundAsync(foreground(context)).get(); }
            catch (Exception error) {
                // A device may deny background foreground-service starts. The active
                // WorkManager job can still finish normally within the server deadline.
                if (isStopped()) return Result.retry();
            }
            main.post(() -> {
                if (isStopped() || epoch != CollectionTasks.epoch(context)) { done.complete(true); return; }
                CollectionEngine.get(context).start(getId().toString(),getRunAttemptCount() == 0 && getInputData().getBoolean("manual",false),
                        CollectionRetryPolicy.expectedJob(getRunAttemptCount(),getInputData().getString("job")),done);
            });
            // Ordinary workers have a ten-minute limit. Leave time for cleanup before that limit.
            return done.get(8,TimeUnit.MINUTES) ? Result.success() : Result.retry();
        } catch (ServerApi.ApiException error) { return error.status == 401 ? Result.failure() : Result.retry(); }
        catch (Exception error) { return Result.retry(); }
        finally { main.post(() -> CollectionEngine.releaseIfPresent(getId().toString())); }
    }
    @Override public void onStopped() {
        main.post(() -> CollectionEngine.releaseIfPresent(getId().toString()));
    }
}
