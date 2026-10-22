package ru.pricechecker.lamoda;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.Manifest;
import android.content.pm.PackageManager;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public final class ReminderService extends FirebaseMessagingService {
    static final String CHANNEL = "lamoda_reminders", TAG = "lamoda-reminder";
    static void channel(Context context) {
        NotificationChannel channel = new NotificationChannel(CHANNEL,"Обновление избранного Lamoda",NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Напоминание открыть приложение и обновить цены");
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }
    static boolean allowed(Context context) {
        channel(context);
        return (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
                && context.getSystemService(NotificationManager.class).areNotificationsEnabled()
                && context.getSystemService(NotificationManager.class).getNotificationChannel(CHANNEL).getImportance() != NotificationManager.IMPORTANCE_NONE;
    }
    static void dismiss(Context context) { context.getSystemService(NotificationManager.class).cancel(TAG,0); }
    @Override public void onNewToken(String token) {
        getSharedPreferences("push",0).edit().putString("token",token).apply();
        PushRegistration.schedule(this);
    }
    @Override public void onMessageReceived(RemoteMessage message) {
        String job = message.getData().get("lamoda_job"), expiry = message.getData().get("lamoda_expires");
        if (!ReminderPolicy.valid(job,expiry,System.currentTimeMillis()) || !allowed(this)) return;
        Intent intent = new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra("lamoda_job",job).putExtra("lamoda_expires",expiry);
        PendingIntent open = PendingIntent.getActivity(this,0,intent,PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this,CHANNEL).setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Пора обновить Lamoda").setContentText("Нажмите, чтобы открыть избранное и начать сбор.")
                .setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(true)
                .setTimeoutAfter(Long.parseLong(expiry)-System.currentTimeMillis()).build();
        try { getSystemService(NotificationManager.class).notify(TAG,0,notification); }
        catch (SecurityException ignored) { /* Permission can be revoked while handling a message. */ }
    }
}
