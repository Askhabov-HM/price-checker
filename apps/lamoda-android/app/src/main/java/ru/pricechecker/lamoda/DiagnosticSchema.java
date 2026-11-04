package ru.pricechecker.lamoda;

import java.time.Instant;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

// An allowlist at the local recording boundary, independently of VPS validation.
final class DiagnosticSchema {
    private DiagnosticSchema(){}
    private static final Set<String> BOOLEAN=new HashSet<>(Arrays.asList("screen_locked","screen_off","idle","battery_saver","battery_exempt","background_restricted","network_validated"));
    private static boolean oneOf(Object value,String choices){return value instanceof String&&Arrays.asList(choices.split("\\|")).contains(value);}
    static boolean valid(String key,Object value) {
        if(key.equals("run_id")||key.equals("job_id"))return value instanceof String&&((String)value).matches("[a-f0-9]{32}");
        if(BOOLEAN.contains(key))return value instanceof Boolean;
        switch(key) {
            case "action":return oneOf(value,"pair|next|start|page|fail|push|stop|capabilities");
            case "phase":return oneOf(value,"BEGIN|OK|ERROR");
            case "stage":return oneOf(value,"requesting|reading|uploading|waiting|finished|canceling");
            case "outcome":return oneOf(value,"canceled|completed|ended|idle");
            case "issue":return oneOf(value,"LINK|AUTH|BUSY|HTTP|REDIRECT|RESPONSE|DNS|TIMEOUT|TLS|CONNECT|NETWORK|STORAGE|UNKNOWN|UPGRADE");
            case "work_state":return oneOf(value,"ENQUEUED|RUNNING|SUCCEEDED|FAILED|BLOCKED|CANCELLED");
            case "next_run_at":case "exit_at":
                try{return value instanceof String&&((String)value).length()<=40&&Instant.parse((String)value)!=null;}catch(RuntimeException error){return false;}
            case "page":return integer(value,1,1000);
            case "attempt":return integer(value,0,100000);
            case "duration_ms":return integer(value,0,86400000);
            case "http_status":return integer(value,0,599);
            case "stop_reason":return integer(value,-256,65535);
            case "exit_reason":return integer(value,0,65535);
            case "exit_status":return integer(value,Integer.MIN_VALUE,Integer.MAX_VALUE);
            case "importance":return integer(value,0,10000);
            case "dropped_events":return integer(value,0,Integer.MAX_VALUE);
            default:return false;
        }
    }
    private static boolean integer(Object value,long min,long max) {
        return (value instanceof Integer||value instanceof Long)&&((Number)value).longValue()>=min&&((Number)value).longValue()<=max;
    }
}
