package com.rcloneflix.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MediaPlaybackService extends Service {
    private static final String TAG = "RcloneFlixMediaSvc";
    private static final String CHANNEL_ID = "rcloneflix_media_channel";
    private static final int NOTIFICATION_ID = 1001;

    public static final String ACTION_UPDATE = "com.rcloneflix.app.action.UPDATE_MEDIA";
    public static final String ACTION_STOP = "com.rcloneflix.app.action.STOP_MEDIA";
    public static final String ACTION_PLAY = "com.rcloneflix.app.action.PLAY";
    public static final String ACTION_PAUSE = "com.rcloneflix.app.action.PAUSE";
    public static final String ACTION_NEXT = "com.rcloneflix.app.action.NEXT";
    public static final String ACTION_PREV = "com.rcloneflix.app.action.PREV";

    private static volatile boolean activelyPlaying = false;
    private static volatile boolean serviceRunning = false;

    private MediaSession mediaSession;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private final ExecutorService artExecutor = Executors.newSingleThreadExecutor();

    private String currentTitle = "RcloneFlix";
    private String currentArtist = "";
    private String currentAlbum = "";
    private long currentDurationMs = 0L;
    private long currentPositionMs = 0L;
    private boolean isPlaying = false;
    private String currentCoverUrl = "";
    private Bitmap currentCoverBitmap = null;

    public static boolean isActivelyPlaying() {
        return activelyPlaying;
    }

    public static boolean isServiceRunning() {
        return serviceRunning;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        serviceRunning = true;
        createNotificationChannel();
        initLocks();
        initMediaSession();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "RcloneFlix Media Playback",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Background audio playback controls");
            channel.setShowBadge(false);
            channel.setSound(null, null);
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    private void initLocks() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "rcloneflix:audio_playback");
                wakeLock.setReferenceCounted(false);
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to init WakeLock", e);
        }

        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                int lockMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                        ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                        : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifiLock = wm.createWifiLock(lockMode, "rcloneflix:audio_wifi");
                wifiLock.setReferenceCounted(false);
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to init WifiLock", e);
        }

    }

    private void initMediaSession() {
        mediaSession = new MediaSession(this, "RcloneFlixMediaSession");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                MainActivity.dispatchMediaControl("play", 0);
            }

            @Override
            public void onPause() {
                MainActivity.dispatchMediaControl("pause", 0);
            }

            @Override
            public void onSkipToNext() {
                MainActivity.dispatchMediaControl("next", 0);
            }

            @Override
            public void onSkipToPrevious() {
                MainActivity.dispatchMediaControl("prev", 0);
            }

            @Override
            public void onSeekTo(long pos) {
                MainActivity.dispatchMediaControl("seek", pos / 1000.0);
            }

            @Override
            public void onStop() {
                MainActivity.dispatchMediaControl("stop", 0);
                stopSelfCleanly();
            }
        });
        mediaSession.setActive(true);
    }

    private void acquireLocksAndFocus() {
        try {
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire(6 * 60 * 60 * 1000L); // up to 6 hours per track
            }
        } catch (Exception ignored) {}
        try {
            if (wifiLock != null && !wifiLock.isHeld()) {
                wifiLock.acquire();
            }
        } catch (Exception ignored) {}
        // NOTE: AudioFocus is managed directly by Chromium WebView (<audio>).
        // Requesting AUDIOFOCUS_GAIN from this background service steals focus from WebView,
        // causing Android to pause playback after ~0.5s and mute WebView's AudioTrack on resume.
    }

    private void releaseLocksAndFocus() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {}
        try {
            if (wifiLock != null && wifiLock.isHeld()) {
                wifiLock.release();
            }
        } catch (Exception ignored) {}
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            return START_NOT_STICKY;
        }
        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopSelfCleanly();
            return START_NOT_STICKY;
        }
        if (ACTION_PLAY.equals(action)) {
            MainActivity.dispatchMediaControl("play", 0);
            return START_STICKY;
        }
        if (ACTION_PAUSE.equals(action)) {
            MainActivity.dispatchMediaControl("pause", 0);
            return START_STICKY;
        }
        if (ACTION_NEXT.equals(action)) {
            MainActivity.dispatchMediaControl("next", 0);
            return START_STICKY;
        }
        if (ACTION_PREV.equals(action)) {
            MainActivity.dispatchMediaControl("prev", 0);
            return START_STICKY;
        }

        if (ACTION_UPDATE.equals(action)) {
            currentTitle = intent.getStringExtra("title") != null ? intent.getStringExtra("title") : "RcloneFlix";
            currentArtist = intent.getStringExtra("artist") != null ? intent.getStringExtra("artist") : "";
            currentAlbum = intent.getStringExtra("album") != null ? intent.getStringExtra("album") : "";
            currentDurationMs = intent.getLongExtra("durationMs", 0L);
            currentPositionMs = intent.getLongExtra("positionMs", 0L);
            isPlaying = intent.getBooleanExtra("isPlaying", false);
            String newCoverUrl = intent.getStringExtra("coverUrl") != null ? intent.getStringExtra("coverUrl") : "";

            activelyPlaying = isPlaying;
            if (isPlaying) {
                acquireLocksAndFocus();
            }

            if (!newCoverUrl.equals(currentCoverUrl)) {
                currentCoverUrl = newCoverUrl;
                currentCoverBitmap = null;
                if (!newCoverUrl.isEmpty() && (newCoverUrl.startsWith("http://") || newCoverUrl.startsWith("https://"))) {
                    final String targetUrl = newCoverUrl;
                    artExecutor.execute(() -> {
                        Bitmap bmp = fetchBitmap(targetUrl);
                        if (bmp != null && targetUrl.equals(currentCoverUrl)) {
                            currentCoverBitmap = bmp;
                            updateSessionAndNotification();
                        }
                    });
                }
            }

            updateSessionAndNotification();
        }

        return START_STICKY;
    }

    private Bitmap fetchBitmap(String urlStr) {
        HttpURLConnection conn = null;
        try {
            URL u = new URL(urlStr);
            conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setDoInput(true);
            conn.connect();
            try (InputStream is = conn.getInputStream()) {
                return BitmapFactory.decodeStream(is);
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignored) {}
            }
        }
    }

    private void updateSessionAndNotification() {
        try {
            MediaMetadata.Builder metaBuilder = new MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, currentTitle)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, currentArtist)
                    .putString(MediaMetadata.METADATA_KEY_ALBUM, currentAlbum)
                    .putLong(MediaMetadata.METADATA_KEY_DURATION, currentDurationMs);
            if (currentCoverBitmap != null) {
                metaBuilder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, currentCoverBitmap);
            }
            mediaSession.setMetadata(metaBuilder.build());

            long actions = PlaybackState.ACTION_PLAY
                    | PlaybackState.ACTION_PAUSE
                    | PlaybackState.ACTION_PLAY_PAUSE
                    | PlaybackState.ACTION_SKIP_TO_NEXT
                    | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                    | PlaybackState.ACTION_SEEK_TO
                    | PlaybackState.ACTION_STOP;

            PlaybackState state = new PlaybackState.Builder()
                    .setActions(actions)
                    .setState(
                            isPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                            currentPositionMs,
                            isPlaying ? 1.0f : 0.0f
                    )
                    .build();
            mediaSession.setPlaybackState(state);

            Notification notification = buildNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to update media session notification", e);
        }
    }

    private PendingIntent createServiceIntent(String action, int reqCode) {
        Intent i = new Intent(this, MediaPlaybackService.class);
        i.setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getService(this, reqCode, i, flags);
    }

    private Notification buildNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            piFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent = PendingIntent.getActivity(this, 100, openIntent, piFlags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        Notification.MediaStyle style = new Notification.MediaStyle()
                .setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2);

        builder.setStyle(style)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(currentTitle)
                .setContentText(currentArtist.isEmpty() ? currentAlbum : currentArtist)
                .setSubText(currentAlbum)
                .setContentIntent(contentIntent)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOngoing(isPlaying)
                .setOnlyAlertOnce(true);

        if (currentCoverBitmap != null) {
            builder.setLargeIcon(currentCoverBitmap);
        }

        Notification.Action prevAction = new Notification.Action.Builder(
                Icon.createWithResource(this, android.R.drawable.ic_media_previous),
                "Previous",
                createServiceIntent(ACTION_PREV, 1)
        ).build();

        Notification.Action playPauseAction = new Notification.Action.Builder(
                Icon.createWithResource(this, isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play),
                isPlaying ? "Pause" : "Play",
                createServiceIntent(isPlaying ? ACTION_PAUSE : ACTION_PLAY, 2)
        ).build();

        Notification.Action nextAction = new Notification.Action.Builder(
                Icon.createWithResource(this, android.R.drawable.ic_media_next),
                "Next",
                createServiceIntent(ACTION_NEXT, 3)
        ).build();

        builder.addAction(prevAction);
        builder.addAction(playPauseAction);
        builder.addAction(nextAction);

        return builder.build();
    }

    private void stopSelfCleanly() {
        activelyPlaying = false;
        serviceRunning = false;
        releaseLocksAndFocus();
        try {
            stopForeground(true);
        } catch (Exception ignored) {}
        stopSelf();
    }

    @Override
    public void onDestroy() {
        activelyPlaying = false;
        serviceRunning = false;
        releaseLocksAndFocus();
        if (mediaSession != null) {
            try {
                mediaSession.setActive(false);
                mediaSession.release();
            } catch (Exception ignored) {}
        }
        artExecutor.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
