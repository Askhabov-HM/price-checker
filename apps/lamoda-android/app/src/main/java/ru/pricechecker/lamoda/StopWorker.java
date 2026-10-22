package ru.pricechecker.lamoda;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

public final class StopWorker extends Worker {
    public StopWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context,params); }
    @NonNull @Override public Result doWork() {
        try { CollectionTasks.flushStops(getApplicationContext()); return Result.success(); }
        catch (ServerApi.ApiException error) { return error.status == 401 ? Result.failure() : Result.retry(); }
        catch (Exception error) { return Result.retry(); }
    }
}
