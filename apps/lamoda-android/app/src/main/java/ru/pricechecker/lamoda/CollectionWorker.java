package ru.pricechecker.lamoda;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

public final class CollectionWorker extends Worker {
    private final Handler main = new Handler(Looper.getMainLooper());
    public CollectionWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context,params); }
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
            main.post(() -> {
                if (isStopped() || epoch != CollectionTasks.epoch(context)) { done.complete(true); return; }
                CollectionEngine.get(context).start(getId().toString(),getRunAttemptCount() == 0 && getInputData().getBoolean("manual",false),
                        getInputData().getString("job"),done);
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
