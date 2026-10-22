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
        channel.setDescription("Фоновое обновление цен и сообщения о необходимости входа");
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }
    static boolean allowed(Context context) {
        channel(context);
        return (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
                && context.getSystemService(NotificationManager.class).areNotificationsEnabled()
                && context.getSystemService(NotificationManager.class).getNotificationChannel(CHANNEL).getImportance() != NotificationManager.IMPORTANCE_NONE;
    }
    static void dismissProgress(Context context) { context.getSystemService(NotificationManager.class).cancel(TAG,0); }
    static void dismiss(Context context) {
        dismissProgress(context); context.getSystemService(NotificationManager.class).cancel(TAG+"-attention",0);
    }
    static void attention(Context context, String text) {
        if (!allowed(context)) return;
        PendingIntent open = PendingIntent.getActivity(context,1,new Intent(context,MainActivity.class),PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            context.getSystemService(NotificationManager.class).notify(TAG+"-attention",0,new Notification.Builder(context,CHANNEL)
                    .setSmallIcon(R.drawable.ic_notification).setContentTitle("Lamoda: требуется действие")
                    .setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text)).setContentIntent(open).setAutoCancel(true).build());
        } catch (SecurityException ignored) { /* Permission can change while posting. */ }
    }
    @Override public void onNewToken(String token) {
        getSharedPreferences("push",0).edit().putString("token",token).apply();
        PushRegistration.schedule(this);
    }
    @Override public void onMessageReceived(RemoteMessage message) {
        String job = message.getData().get("lamoda_job"), expiry = message.getData().get("lamoda_expires");
        if (!ReminderPolicy.valid(job,expiry,System.currentTimeMillis())) return;
        CollectionTasks.request(this,false,job);
        if (!allowed(this)) return;
        Intent intent = new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra("lamoda_job",job).putExtra("lamoda_expires",expiry);
        PendingIntent open = PendingIntent.getActivity(this,0,intent,PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this,CHANNEL).setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Обновляем Lamoda в фоне").setContentText("Нажмите, чтобы посмотреть сбор или остановить его.")
                .setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(true)
                .setTimeoutAfter(Long.parseLong(expiry)-System.currentTimeMillis()).build();
        try { getSystemService(NotificationManager.class).notify(TAG,0,notification); }
        catch (SecurityException ignored) { /* Permission can be revoked while handling a message. */ }
    }
}
