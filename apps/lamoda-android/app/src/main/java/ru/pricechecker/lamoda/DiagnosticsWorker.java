package ru.pricechecker.lamoda;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.HashSet;
import java.util.Set;

public final class DiagnosticsWorker extends Worker {
    public DiagnosticsWorker(@NonNull Context context,@NonNull WorkerParameters params){super(context,params);}
    @NonNull @Override public Result doWork() {
        Context context=getApplicationContext();CollectorStore store=CollectorStore.get(context);
        try {
            String token=new TokenVault(context).read();if(token.isEmpty())return Result.success();
            String origin=context.getSharedPreferences("connection",0).getString("server",BuildConfig.DEFAULT_SERVER);
            ServerApi api=new ServerApi(origin,token,context);
            for(int batch=0;batch<10&&!isStopped();batch++) {
                JSONArray events=store.batch();if(events.length()==0)return Result.success();
                JSONArray ack=api.call("telemetry",new JSONObject().put("events",events)).getJSONArray("ack");
                Set<String> sent=new HashSet<>(),received=new HashSet<>();
                for(int i=0;i<events.length();i++)sent.add(events.getJSONObject(i).getString("event_id"));
                for(int i=0;i<ack.length();i++)received.add(ack.getString(i));
                Set<String> confirmed=DiagnosticDelivery.confirmed(sent,received);
                if(confirmed.isEmpty())return Result.retry();store.acknowledge(confirmed);
            }
            return Result.retry();
        }catch(ServerApi.ApiException error){return error.status==401||error.status==404||error.status==405?Result.success():Result.retry();}
        catch(Exception ignored){return Result.retry();}
    }
}
