package ru.pricechecker.lamoda;

import android.app.ActivityManager;
import android.app.KeyguardManager;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.PowerManager;
import android.util.Log;
import org.json.JSONObject;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

final class CollectorDiagnostics {
    enum Event { APP_OPEN,LINK_RECEIVED,LINK_VALID,LINK_INVALID,PAIR_SAVED,PAIR_SAVE_FAILED,PAIR_FAILED,
        FORGOTTEN,WORK_REQUEST_MANUAL,WORK_REQUEST_PUSH,WORK_REQUEST_POLL,WORK_NO_TOKEN,WORK_STARTED,WORK_TICK,WORK_STALE,
        WORK_SUCCESS,WORK_RETRY,WORK_FAILED,WORK_STOPPED,FOREGROUND_DENIED,PUSH_RECEIVED,PUSH_EXPIRED,PUSH_REGISTERED,
        PUSH_REGISTRATION_FAILED,SOURCE_LOGIN_REQUIRED,SOURCE_ACCOUNT_MISMATCH,SOURCE_UNVERIFIED,SOURCE_ERROR,RENDERER_GONE,
        PROCESS_START,PROCESS_ALIVE,PROCESS_EXIT,WORK_STATE,API,PROGRESS,HEARTBEAT,CANCEL_REQUESTED,CANCEL_ACK,CANCEL_PENDING }
    enum Phase {BEGIN,OK,ERROR}
    enum Stage {requesting,reading,uploading,waiting,finished,canceling}
    private static final String PROCESS=UUID.randomUUID().toString().replace("-","");
    private static final AtomicInteger sequence=new AtomicInteger();
    private CollectorDiagnostics(){}
    static boolean id(String value){return value!=null&&value.matches("[a-f0-9]{32}");}
    static JSONObject environment(Context context)throws Exception {
        PowerManager power=context.getSystemService(PowerManager.class);
        ConnectivityManager network=context.getSystemService(ConnectivityManager.class);
        NetworkCapabilities capabilities=network.getNetworkCapabilities(network.getActiveNetwork());
        return new JSONObject().put("screen_locked",context.getSystemService(KeyguardManager.class).isDeviceLocked())
                .put("screen_off",!power.isInteractive()).put("idle",power.isDeviceIdleMode()).put("battery_saver",power.isPowerSaveMode())
                .put("battery_exempt",power.isIgnoringBatteryOptimizations(context.getPackageName()))
                .put("background_restricted",android.os.Build.VERSION.SDK_INT>=28&&context.getSystemService(ActivityManager.class).isBackgroundRestricted())
                .put("dropped_events",CollectorStore.get(context).meta("dropped"))
                .put("network_validated",capabilities!=null&&capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
    }
    static void event(Context context,Event event){record(context,event,new JSONObject());}
    static void record(Context context,Event event,JSONObject fields) {
        try {
            JSONObject value=environment(context);
            // Only explicitly selected fields; never source data, URLs or exception text.
            java.util.Iterator<String> keys=fields.keys();while(keys.hasNext()){
                String key=keys.next();Object item=fields.get(key);
                if(!DiagnosticSchema.valid(key,item))throw new IllegalArgumentException("Unsafe diagnostic field");
                value.put(key,item);
            }
            value.put("event_id",UUID.randomUUID().toString().replace("-","")).put("process_id",PROCESS)
                    .put("seq",sequence.incrementAndGet()).put("event",event.name()).put("event_at",Instant.now().toString());
            CollectorStore.get(context).append(value);Log.i("LamodaCollector",value.toString());
            if(event!=Event.PROCESS_ALIVE)CollectionTasks.syncDiagnostics(context);
        }catch(Exception ignored){Log.w("LamodaCollector","JOURNAL_WRITE_FAILED");}
    }
    static void progress(Context context,Event event,String run,String job,int page,Stage stage) {
        try{JSONObject fields=new JSONObject().put("stage",stage.name());if(id(run))fields.put("run_id",run);if(id(job))fields.put("job_id",job);if(page>0)fields.put("page",page);record(context,event,fields);}
        catch(Exception ignored){/* No untrusted error text. */}
    }
    static void api(Context context,String action,Phase phase,int status,ConnectionIssue.Kind issue,long duration,JSONObject body) {
        if(!action.matches("pair|next|start|page|fail|push|stop|capabilities"))return;
        try {
            JSONObject fields=new JSONObject().put("action",action).put("phase",phase.name()).put("http_status",status).put("duration_ms",duration);
            if(issue!=null)fields.put("issue",issue.name());
            if(body!=null){for(String key:new String[]{"run_id","job_id"})if(id(body.optString(key)))fields.put(key,body.getString(key));int page=body.optInt("page");if(page>0&&page<=1000)fields.put("page",page);}
            record(context,Event.API,fields);
        }catch(Exception ignored){/* Never log the body itself. */}
    }
    static String failure(Exception error,boolean pairing) {
        if(error instanceof ServerApi.UpgradeRequired)return "Нужна новая серверная часть Lamoda. Обновите VPS перед запуском этой сборки приложения.";
        int status=error instanceof ServerApi.ApiException?((ServerApi.ApiException)error).status:0;
        return ConnectionIssue.message(ConnectionIssue.kind(error,status,pairing));
    }
    static String report(Context context) {
        String server;try{server=AddressPolicy.server(context.getSharedPreferences("connection",0).getString("server",BuildConfig.DEFAULT_SERVER));}catch(RuntimeException error){server="некорректный адрес";}
        String current;try{current=environment(context).toString();}catch(Exception ignored){current="недоступно";}
        return "Lamoda Collector "+BuildConfig.VERSION_NAME+" / protocol=2\nVPS: "+server+"\nТекущее состояние Android: "+current
                +"\nПодключение сохранено: "+!context.getSharedPreferences("connection",0).getString("token","").isEmpty()
                +"\nУведомления разрешены: "+ReminderService.allowed(context)+"\n"+CollectorStore.get(context).report();
    }
}
