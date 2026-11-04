package ru.pricechecker.lamoda;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Collection;
import java.util.UUID;

// Canceling locally and queuing the server cancellation share a durable transaction.
final class CollectorStore extends SQLiteOpenHelper {
    private static CollectorStore instance;
    static synchronized CollectorStore get(Context context) {
        if (instance==null) instance=new CollectorStore(context.getApplicationContext());return instance;
    }
    private CollectorStore(Context context) {super(context,"collector-state.db",null,1);setWriteAheadLoggingEnabled(true);}
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE runs(id TEXT PRIMARY KEY,manual INTEGER NOT NULL,expected TEXT,job_id TEXT,state TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0,outcome TEXT)");
        db.execSQL("CREATE TABLE cancellations(run_id TEXT PRIMARY KEY,job_id TEXT)");
        db.execSQL("CREATE TABLE meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL)");
    }
    @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion) {throw new IllegalStateException("Unsupported collector storage version");}
    synchronized void append(JSONObject event) throws Exception {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            ContentValues row=new ContentValues();row.put("event_id",event.getString("event_id"));row.put("payload",event.toString());db.insertOrThrow("events",null,row);
            try(Cursor count=db.rawQuery("SELECT COUNT(*),COALESCE(SUM(LENGTH(payload)),0) FROM events",null)) {
                count.moveToFirst();int rows=count.getInt(0),bytes=count.getInt(1);
                if(rows>5000 || bytes>5*1024*1024) {
                    int remove=Math.max(100,rows-4900);
                    db.execSQL("INSERT OR IGNORE INTO meta VALUES('dropped',0)");
                    db.execSQL("UPDATE meta SET value=value+(SELECT COUNT(*) FROM (SELECT delivered FROM events ORDER BY id LIMIT ?) WHERE delivered=0) WHERE key='dropped'",new Object[]{remove});
                    db.execSQL("DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id LIMIT ?)",new Object[]{remove});
                }
            }
            db.setTransactionSuccessful();
        } finally {db.endTransaction();}
    }
    synchronized JSONArray batch() throws Exception {
        JSONArray result=new JSONArray();
        try(Cursor c=getReadableDatabase().rawQuery("SELECT payload FROM events WHERE delivered=0 ORDER BY id LIMIT 50",null)) {while(c.moveToNext())result.put(new JSONObject(c.getString(0)));}
        return result;
    }
    synchronized void acknowledge(Collection<String> ids) {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try{for(String id:ids)db.execSQL("UPDATE events SET delivered=1 WHERE event_id=?",new Object[]{id});db.setTransactionSuccessful();}finally{db.endTransaction();}
    }
    synchronized String report() {
        StringBuilder result=new StringBuilder();
        try(Cursor c=getReadableDatabase().rawQuery("SELECT COUNT(*) FROM events WHERE delivered=0",null)){c.moveToFirst();result.append("Ожидают отправки: ").append(c.getInt(0));}
        try(Cursor c=getReadableDatabase().rawQuery("SELECT value FROM meta WHERE key='dropped'",null)){result.append("\nНеотправленных событий удалено по лимиту: ").append(c.moveToFirst()?c.getLong(0):0);}
        result.append("\nПоследние события (UTC):\n");
        try(Cursor c=getReadableDatabase().rawQuery("SELECT payload,delivered FROM events ORDER BY id DESC LIMIT 80",null)){while(c.moveToNext())result.append(c.getString(0)).append(c.getInt(1)==0?" [ожидает VPS]":" [доставлено]").append('\n');}
        return result.toString();
    }
    synchronized String active() {
        try(Cursor c=getReadableDatabase().rawQuery("SELECT id FROM runs WHERE state IN ('queued','running') ORDER BY rowid DESC LIMIT 1",null)){return c.moveToFirst()?c.getString(0):null;}
    }
    synchronized String begin(boolean manual,String expected,String proposed) {
        String existing=active();if(existing!=null)return existing;
        String id=proposed==null?UUID.randomUUID().toString().replace("-",""):proposed;
        ContentValues row=new ContentValues();row.put("id",id);row.put("manual",manual?1:0);row.put("expected",CollectorDiagnostics.id(expected)?expected:null);row.put("state","queued");
        getWritableDatabase().insertWithOnConflict("runs",null,row,SQLiteDatabase.CONFLICT_IGNORE);return id;
    }
    synchronized boolean canceled(String id) {
        try(Cursor c=getReadableDatabase().rawQuery("SELECT state FROM runs WHERE id=?",new String[]{id})){return !c.moveToFirst()||"canceled".equals(c.getString(0));}
    }
    synchronized JSONObject run(String id) throws Exception {
        try(Cursor c=getReadableDatabase().rawQuery("SELECT manual,expected FROM runs WHERE id=?",new String[]{id})) {
            if(!c.moveToFirst())return null;return new JSONObject().put("manual",c.getInt(0)!=0).put("expected",c.isNull(1)?"":c.getString(1));
        }
    }
    synchronized boolean markSent(String id) {
        ContentValues row=new ContentValues();row.put("sent",1);row.put("state","running");
        return getWritableDatabase().update("runs",row,"id=? AND state IN ('queued','running')",new String[]{id})>0;
    }
    synchronized void bind(String id,String job) {
        getWritableDatabase().execSQL("UPDATE runs SET job_id=? WHERE id=?",new Object[]{job,id});
        if(canceled(id))getWritableDatabase().execSQL("UPDATE cancellations SET job_id=? WHERE run_id=?",new Object[]{job,id});
    }
    synchronized void finish(String id){getWritableDatabase().execSQL("UPDATE runs SET state='finished' WHERE id=? AND state!='canceled'",new Object[]{id});}
    synchronized boolean cancel(String id) {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();boolean remote=false;
        try(Cursor c=db.rawQuery("SELECT sent,COALESCE(job_id,expected),state FROM runs WHERE id=?",new String[]{id})) {
            if(c.moveToFirst()&&!"finished".equals(c.getString(2))) {
                remote=c.getInt(0)!=0||!c.isNull(1);
                db.execSQL("UPDATE runs SET state='canceled',outcome=? WHERE id=?",new Object[]{remote?"pending":"local",id});
                if(remote){ContentValues row=new ContentValues();row.put("run_id",id);row.put("job_id",c.isNull(1)?null:c.getString(1));db.insertWithOnConflict("cancellations",null,row,SQLiteDatabase.CONFLICT_REPLACE);}
            }
            db.setTransactionSuccessful();return remote;
        } finally{db.endTransaction();}
    }
    synchronized JSONArray cancellations() throws Exception {
        JSONArray result=new JSONArray();
        try(Cursor c=getReadableDatabase().rawQuery("SELECT run_id,job_id FROM cancellations ORDER BY rowid",null)){while(c.moveToNext()){JSONObject row=new JSONObject().put("run_id",c.getString(0));if(!c.isNull(1))row.put("job_id",c.getString(1));result.put(row);}}
        return result;
    }
    synchronized boolean pendingCancellation(){try(Cursor c=getReadableDatabase().rawQuery("SELECT 1 FROM cancellations LIMIT 1",null)){return c.moveToFirst();}}
    synchronized void cancelAcknowledged(String id,String outcome) {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try{db.execSQL("UPDATE runs SET outcome=? WHERE id=?",new Object[]{outcome,id});db.delete("cancellations","run_id=?",new String[]{id});db.setTransactionSuccessful();}finally{db.endTransaction();}
    }
    synchronized String lastCancellation(){try(Cursor c=getReadableDatabase().rawQuery("SELECT state,outcome FROM runs ORDER BY rowid DESC LIMIT 1",null)){return c.moveToFirst()&&"canceled".equals(c.getString(0))?c.getString(1):null;}}
    synchronized void forget(){SQLiteDatabase db=getWritableDatabase();db.execSQL("UPDATE runs SET state='finished' WHERE state IN ('queued','running','canceled')");db.delete("cancellations",null,null);}
    synchronized long meta(String key){try(Cursor c=getReadableDatabase().rawQuery("SELECT value FROM meta WHERE key=?",new String[]{key})){return c.moveToFirst()?c.getLong(0):0;}}
    synchronized void meta(String key,long value){ContentValues row=new ContentValues();row.put("key",key);row.put("value",value);getWritableDatabase().insertWithOnConflict("meta",null,row,SQLiteDatabase.CONFLICT_REPLACE);}
}
