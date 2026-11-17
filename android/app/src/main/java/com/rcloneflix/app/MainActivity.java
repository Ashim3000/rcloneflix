package com.rcloneflix.app;

import android.app.PictureInPictureParams;
import android.app.UiModeManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.Uri;
import android.content.ActivityNotFoundException;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.util.Rational;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "RcloneFlix";
    private static final int PAIRING_PORT = 8080;
    private static volatile MainActivity instance = null;

    private Process rcloneProcess = null;
    private String currentServedRoot = null;
    private int currentServedPort = -1;

    private ServerSocket pairingServer = null;
    private volatile boolean isServerRunning = false;

    private volatile boolean isPipEligible = false;
    private volatile int pipVideoWidth = 16;
    private volatile int pipVideoHeight = 9;
    private volatile boolean isTextInputEditing = false;
    private long lastDpadRepeatTime = 0L;

    public static void dispatchMediaControl(final String action, final double value) {
        MainActivity act = instance;
        if (act == null || act.getBridge() == null) return;
        WebView wv = act.getBridge().getWebView();
        if (wv != null) {
            wv.post(() -> wv.evaluateJavascript(
                    "(function(){ " +
                    "window.dispatchEvent(new CustomEvent('rcloneflix:media-control', { detail: { action: '" + action + "', value: " + value + " } })); " +
                    "if (typeof window.__rcloneflix_media_control === 'function') { window.__rcloneflix_media_control('" + action + "', " + value + "); } " +
                    "})();",
                    null
            ));
        }
    }

    private final List<String> nativeLogLines = new ArrayList<>();
    private final ExecutorService asyncPool = Executors.newCachedThreadPool();
    private final ExecutorService taskPool = new java.util.concurrent.ThreadPoolExecutor(
            4, 8, 60L, TimeUnit.SECONDS, new java.util.concurrent.LinkedBlockingQueue<>());
    private final ConcurrentHashMap<Integer, String> pendingTaskResults = new ConcurrentHashMap<>();
    private volatile String pendingPairPayload = null;
    private SSLSocketFactory permissiveSslFactory = null;
    private final HostnameVerifier permissiveVerifier = (hostname, session) -> true;

    private synchronized SSLSocketFactory getPermissiveSslFactory() {
        if (permissiveSslFactory != null) return permissiveSslFactory;
        try {
            TrustManager[] trustAllCerts = new TrustManager[]{
                new X509TrustManager() {
                    @Override
                    public void checkClientTrusted(X509Certificate[] chain, String authType) {}
                    @Override
                    public void checkServerTrusted(X509Certificate[] chain, String authType) {}
                    @Override
                    public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                }
            };
            SSLContext sc = SSLContext.getInstance("TLS");
            sc.init(null, trustAllCerts, new SecureRandom());
            permissiveSslFactory = sc.getSocketFactory();
        } catch (Exception e) {
            Log.w(TAG, "Failed to init permissive SSL factory", e);
        }
        return permissiveSslFactory;
    }

    public void configureHttpConnection(HttpURLConnection conn) {
        if (conn instanceof HttpsURLConnection) {
            HttpsURLConnection https = (HttpsURLConnection) conn;
            SSLSocketFactory factory = getPermissiveSslFactory();
            if (factory != null) {
                https.setSSLSocketFactory(factory);
            }
            https.setHostnameVerifier(permissiveVerifier);
        }
    }

    public synchronized void appendLog(String level, String target, String msg) {
        String ts = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", java.util.Locale.US).format(new java.util.Date());
        String line = ts + " [" + (level != null ? level.toUpperCase() : "INFO") + "] (" + (target != null ? target : "app") + ") " + msg;
        nativeLogLines.add(line);
        if (nativeLogLines.size() > 1500) {
            nativeLogLines.remove(0);
        }
        Log.i(TAG, line);
    }

    public synchronized String getLogTail(int maxLines) {
        int total = nativeLogLines.size();
        int start = Math.max(0, total - Math.max(1, maxLines));
        StringBuilder sb = new StringBuilder();
        for (int i = start; i < total; i++) {
            sb.append(nativeLogLines.get(i)).append("\n");
        }
        return sb.toString();
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instance = this;
        setVolumeControlStream(android.media.AudioManager.STREAM_MUSIC);
        if (isTvDevice()) {
            try {
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            } catch (Exception ignored) {}
        }
        applyImmersiveFullscreen();

        // Perform I/O operations (resolv.conf, CA certs extraction, TV pairing server)
        // on a background thread pool so the UI thread is never blocked during Activity launch
        asyncPool.execute(() -> {
            try {
                ensureResolvConf();
                ensureCaCertificates();
                File rcloneBin = getRcloneBinary();
                appendLog("info", "startup", "Rclone binary path: " + rcloneBin.getAbsolutePath() + " (exists=" + rcloneBin.exists() + ")");
                startTvPairingServer();
            } catch (Exception e) {
                Log.w(TAG, "Background startup initialization failed", e);
            }
        });

        // Configure WebView for hardware video decoding & TV remote focus
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            WebSettings settings = webView.getSettings();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setJavaScriptEnabled(true);
            settings.setAllowFileAccess(true);
            settings.setAllowContentAccess(true);

            webView.setFocusable(true);
            webView.setFocusableInTouchMode(true);
            webView.requestFocus();

            // Register native bridge for Rclone and TV discovery
            webView.addJavascriptInterface(new AndroidBridge(this), "AndroidBridge");
        }
    }

    @Override
    public void onDestroy() {
        if (instance == this) {
            instance = null;
        }
        stopRcloneServe();
        stopTvPairingServer();
        super.onDestroy();
    }

    @Override
    public void onPause() {
        super.onPause();
        // Keep WebView timers and HTML5 audio/video stream decoding alive when background audio or PiP is active
        try {
            boolean inPip = Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode();
            if (MediaPlaybackService.isActivelyPlaying() || inPip) {
                WebView wv = getBridge() != null ? getBridge().getWebView() : null;
                if (wv != null) {
                    wv.onResume();
                    wv.resumeTimers();
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to keep WebView active in onPause", e);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        applyImmersiveFullscreen();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applyImmersiveFullscreen();
        }
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (isPipEligible && !isTvDevice()) {
            enterVideoPip(pipVideoWidth, pipVideoHeight);
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        try {
            WebView wv = getBridge() != null ? getBridge().getWebView() : null;
            if (wv != null) {
                if (isInPictureInPictureMode) {
                    wv.onResume();
                    wv.resumeTimers();
                }
                final String boolStr = isInPictureInPictureMode ? "true" : "false";
                wv.post(() -> wv.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('rcloneflix:pip-changed', { detail: { isInPip: " + boolStr + " } }));",
                        null
                ));
            }
        } catch (Exception e) {
            Log.w(TAG, "onPictureInPictureModeChanged error", e);
        }
    }

    public boolean enterVideoPip(int width, int height) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || isTvDevice()) {
            return false;
        }
        try {
            if (!getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
                return false;
            }
            int w = width > 0 ? width : 16;
            int h = height > 0 ? height : 9;
            float ratio = (float) w / (float) h;
            if (ratio < 0.42f) { w = 42; h = 100; }
            else if (ratio > 2.38f) { w = 238; h = 100; }

            PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder()
                    .setAspectRatio(new Rational(w, h));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setAutoEnterEnabled(isPipEligible);
            }
            return enterPictureInPictureMode(builder.build());
        } catch (Exception e) {
            Log.w(TAG, "enterVideoPip failed", e);
            return false;
        }
    }

    /**
     * Enables edge-to-edge sticky immersive fullscreen across Android 8–16+,
     * hiding both the top status bar and bottom navigation bar and extending into display cutouts.
     */
    public void applyImmersiveFullscreen() {
        try {
            Window window = getWindow();
            if (window == null) return;

            window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                WindowManager.LayoutParams lp = window.getAttributes();
                lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                window.setAttributes(lp);
            }

            View decorView = window.getDecorView();
            if (decorView != null) {
                decorView.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                );
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                window.setDecorFitsSystemWindows(false);
                WindowInsetsController controller = window.getInsetsController();
                if (controller != null) {
                    controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                    controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to apply immersive fullscreen", e);
        }
    }

    /**
     * Writes getFilesDir()/.ca-certificates.crt from bundled Mozilla CA bundle + Android system certs.
     * Our patched librclone.so reads ./././././././.ca-certificates.crt relative to getFilesDir(),
     * and we also set SSL_CERT_FILE and SSL_CERT_DIR.
     */
    public File ensureCaCertificates() {
        File certFile = new File(getFilesDir(), ".ca-certificates.crt");
        if (certFile.exists() && certFile.length() > 50000) {
            return certFile;
        }
        try (FileOutputStream fos = new FileOutputStream(certFile)) {
            boolean copiedAsset = false;
            String[] assetPaths = new String[]{"ca-certificates.crt", "public/ca-certificates.crt"};
            for (String ap : assetPaths) {
                try (InputStream is = getAssets().open(ap)) {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = is.read(buf)) != -1) {
                        fos.write(buf, 0, n);
                    }
                    fos.write('\n');
                    copiedAsset = true;
                    break;
                } catch (Exception ignored) {}
            }

            // Also append Android system CA certificates from /system/etc/security/cacerts
            File sysCertsDir = new File("/system/etc/security/cacerts");
            if (sysCertsDir.exists() && sysCertsDir.isDirectory()) {
                File[] files = sysCertsDir.listFiles();
                if (files != null) {
                    byte[] buf = new byte[8192];
                    for (File f : files) {
                        if (f.isFile()) {
                            try (FileInputStream fis = new FileInputStream(f)) {
                                int n;
                                while ((n = fis.read(buf)) != -1) {
                                    fos.write(buf, 0, n);
                                }
                                fos.write('\n');
                            } catch (Exception ignored) {}
                        }
                    }
                }
            }
            appendLog("info", "tls", "Initialized CA bundle at " + certFile.getAbsolutePath() + " (" + certFile.length() + " bytes, asset=" + copiedAsset + ")");
        } catch (Exception e) {
            Log.w(TAG, "Failed to write .ca-certificates.crt", e);
        }
        return certFile;
    }

    /**
     * Writes getFilesDir()/.resolv.conf with active system DNS + public DNS fallbacks.
     * Our patched librclone.so reads ././.resolv.conf relative to its working directory (getFilesDir()).
     */
    public void ensureResolvConf() {
        try {
            StringBuilder sb = new StringBuilder();
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                Network activeNet = cm.getActiveNetwork();
                if (activeNet != null) {
                    LinkProperties lp = cm.getLinkProperties(activeNet);
                    if (lp != null && lp.getDnsServers() != null) {
                        for (InetAddress dns : lp.getDnsServers()) {
                            String hostAddr = dns.getHostAddress();
                            if (hostAddr != null && !hostAddr.isEmpty() && !hostAddr.startsWith("127.")) {
                                sb.append("nameserver ").append(hostAddr).append("\n");
                            }
                        }
                    }
                }
            }
            sb.append("nameserver 8.8.8.8\n");
            sb.append("nameserver 1.1.1.1\n");
            sb.append("nameserver 64.6.64.6\n");

            File resolvFile = new File(getFilesDir(), ".resolv.conf");
            try (FileOutputStream fos = new FileOutputStream(resolvFile)) {
                fos.write(sb.toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to write .resolv.conf", e);
        }
    }

    /**
     * Configures ProcessBuilder working directory and environment variables for librclone.so on Android.
     */
    public void configureProcessBuilder(ProcessBuilder pb) {
        ensureResolvConf();
        File certFile = ensureCaCertificates();
        File filesDir = getFilesDir();
        File cacheDir = getCacheDir();
        pb.directory(filesDir);
        Map<String, String> env = pb.environment();
        env.put("HOME", filesDir.getAbsolutePath());
        env.put("TMPDIR", cacheDir.getAbsolutePath());
        env.put("XDG_CACHE_HOME", cacheDir.getAbsolutePath());
        env.put("XDG_CONFIG_HOME", filesDir.getAbsolutePath());
        env.put("GODEBUG", "netdns=go");
        env.put("SSL_CERT_FILE", certFile.getAbsolutePath());
        env.put("SSL_CERT_DIR", "/system/etc/security/cacerts:/apex/com.android.conscrypt/cacerts");
    }

    /**
     * Resolves the native librclone.so binary extracted by PackageManager into nativeLibraryDir.
     * Executing from nativeLibraryDir satisfies Android 10+ (API 29-36) W^X SELinux policies.
     */
    public File getRcloneBinary() {
        File nativeLib = new File(getApplicationInfo().nativeLibraryDir, "librclone.so");
        if (nativeLib.exists()) {
            nativeLib.setExecutable(true, false);
            return nativeLib;
        }
        File fallback = new File(getFilesDir(), "rclone");
        if (fallback.exists()) {
            fallback.setExecutable(true, false);
        }
        return fallback;
    }

    public File getRcloneConfigFile() {
        File conf = new File(getFilesDir(), "rclone.conf");
        if (!conf.exists()) {
            try {
                conf.createNewFile();
            } catch (Exception ignored) {}
        }
        return conf;
    }

    /**
     * Discovers the device's local LAN IPv4 address (Wi-Fi or Ethernet).
     */
    public String getLocalIpAddress() {
        try {
            List<NetworkInterface> interfaces = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface intf : interfaces) {
                if (intf.isLoopback() || !intf.isUp()) continue;
                String name = intf.getName().toLowerCase();
                if (name.contains("wlan") || name.contains("eth") || name.contains("en")) {
                    for (InetAddress addr : Collections.list(intf.getInetAddresses())) {
                        if (!addr.isLoopbackAddress() && addr instanceof Inet4Address) {
                            String ip = addr.getHostAddress();
                            appendLog("info", "network", "Discovered primary LAN IP (" + name + "): " + ip);
                            return ip;
                        }
                    }
                }
            }
            for (NetworkInterface intf : interfaces) {
                if (intf.isLoopback() || !intf.isUp()) continue;
                for (InetAddress addr : Collections.list(intf.getInetAddresses())) {
                    if (!addr.isLoopbackAddress() && addr instanceof Inet4Address) {
                        String ip = addr.getHostAddress();
                        appendLog("info", "network", "Discovered fallback LAN IP (" + intf.getName() + "): " + ip);
                        return ip;
                    }
                }
            }
        } catch (Exception ex) {
            Log.e(TAG, "Error detecting IP address", ex);
        }
        return "127.0.0.1";
    }

    /**
     * Checks if current device is an Android TV / Google TV / Android Set-Top box.
     */
    public boolean isTvDevice() {
        UiModeManager uiModeManager = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
        if (uiModeManager != null && uiModeManager.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) {
            return true;
        }
        PackageManager pm = getPackageManager();
        if (pm != null && pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)) {
            return true;
        }
        String model = android.os.Build.MODEL != null ? android.os.Build.MODEL.toLowerCase() : "";
        return model.contains("tv") || model.contains("fire") || model.contains("shield") || model.contains("box") || model.contains("chromecast") || model.contains("aft");
    }

    private void dispatchSyntheticKeyToWebView(final String jsKey) {
        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv == null) return;
        wv.post(() -> wv.evaluateJavascript(
                "window.dispatchEvent(new KeyboardEvent('keydown', { key: '" + jsKey + "', bubbles: true, cancelable: true }));",
                null
        ));
    }

    private void dispatchBackToWebView() {
        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv == null) {
            moveTaskToBack(true);
            return;
        }
        wv.post(() -> wv.evaluateJavascript(
                "(function(){ if (typeof window.__rcloneflix_handle_back === 'function') { return window.__rcloneflix_handle_back(); } window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true; })();",
                value -> {
                    if ("false".equals(value)) {
                        runOnUiThread(() -> moveTaskToBack(true));
                    }
                }
        ));
    }

    @Override
    public void onBackPressed() {
        dispatchBackToWebView();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event != null) {
            int action = event.getAction();
            int keyCode = event.getKeyCode();

            // Hardware Volume Controls (Phone, Tablet & Android TV)
            if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
                if (action == KeyEvent.ACTION_DOWN) {
                    android.media.AudioManager am = (android.media.AudioManager) getSystemService(Context.AUDIO_SERVICE);
                    boolean fixed = am != null && am.isVolumeFixed();
                    if (am != null && !fixed) {
                        am.adjustStreamVolume(
                                android.media.AudioManager.STREAM_MUSIC,
                                android.media.AudioManager.ADJUST_RAISE,
                                android.media.AudioManager.FLAG_SHOW_UI
                        );
                    }
                    dispatchMediaControl("volume_up", fixed ? 1.0 : 0.0);
                }
                return true;
            }
            if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
                if (action == KeyEvent.ACTION_DOWN) {
                    android.media.AudioManager am = (android.media.AudioManager) getSystemService(Context.AUDIO_SERVICE);
                    boolean fixed = am != null && am.isVolumeFixed();
                    if (am != null && !fixed) {
                        am.adjustStreamVolume(
                                android.media.AudioManager.STREAM_MUSIC,
                                android.media.AudioManager.ADJUST_LOWER,
                                android.media.AudioManager.FLAG_SHOW_UI
                        );
                    }
                    dispatchMediaControl("volume_down", fixed ? 1.0 : 0.0);
                }
                return true;
            }
            if (keyCode == KeyEvent.KEYCODE_VOLUME_MUTE) {
                if (action == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                    android.media.AudioManager am = (android.media.AudioManager) getSystemService(Context.AUDIO_SERVICE);
                    boolean fixed = am != null && am.isVolumeFixed();
                    if (am != null && !fixed) {
                        am.adjustStreamVolume(
                                android.media.AudioManager.STREAM_MUSIC,
                                android.media.AudioManager.ADJUST_TOGGLE_MUTE,
                                android.media.AudioManager.FLAG_SHOW_UI
                        );
                    }
                    dispatchMediaControl("volume_mute", fixed ? 1.0 : 0.0);
                }
                return true;
            }

            if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_ESCAPE || keyCode == KeyEvent.KEYCODE_BUTTON_B) {
                if (action == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                    dispatchBackToWebView();
                }
                return true;
            }

            if (isTvDevice()) {
                if (action == KeyEvent.ACTION_DOWN) {
                    // Throttle rapid key repeats when holding down D-Pad directions
                    if (event.getRepeatCount() > 0) {
                        long now = System.currentTimeMillis();
                        if (now - lastDpadRepeatTime < 110L) {
                            return true;
                        }
                        lastDpadRepeatTime = now;
                    }

                    switch (keyCode) {
                        case KeyEvent.KEYCODE_DPAD_UP:
                            if (!isTextInputEditing) {
                                dispatchSyntheticKeyToWebView("ArrowUp");
                                return true;
                            }
                            break;
                        case KeyEvent.KEYCODE_DPAD_DOWN:
                            if (!isTextInputEditing) {
                                dispatchSyntheticKeyToWebView("ArrowDown");
                                return true;
                            }
                            break;
                        case KeyEvent.KEYCODE_DPAD_LEFT:
                            if (!isTextInputEditing) {
                                dispatchSyntheticKeyToWebView("ArrowLeft");
                                return true;
                            }
                            break;
                        case KeyEvent.KEYCODE_DPAD_RIGHT:
                            if (!isTextInputEditing) {
                                dispatchSyntheticKeyToWebView("ArrowRight");
                                return true;
                            }
                            break;
                        case KeyEvent.KEYCODE_DPAD_CENTER:
                        case KeyEvent.KEYCODE_ENTER:
                        case KeyEvent.KEYCODE_NUMPAD_ENTER:
                        case KeyEvent.KEYCODE_BUTTON_A:
                            if (!isTextInputEditing && event.getRepeatCount() == 0) {
                                dispatchSyntheticKeyToWebView("Enter");
                                return true;
                            }
                            break;
                        case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                            dispatchMediaControl("toggle", 0);
                            return true;
                        case KeyEvent.KEYCODE_MEDIA_PLAY:
                            dispatchMediaControl("play", 0);
                            return true;
                        case KeyEvent.KEYCODE_MEDIA_PAUSE:
                            dispatchMediaControl("pause", 0);
                            return true;
                        case KeyEvent.KEYCODE_MEDIA_NEXT:
                            dispatchMediaControl("next", 0);
                            return true;
                        case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                            dispatchMediaControl("prev", 0);
                            return true;
                        case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                            dispatchSyntheticKeyToWebView("ArrowRight");
                            return true;
                        case KeyEvent.KEYCODE_MEDIA_REWIND:
                            dispatchSyntheticKeyToWebView("ArrowLeft");
                            return true;
                    }
                } else if (action == KeyEvent.ACTION_UP) {
                    switch (keyCode) {
                        case KeyEvent.KEYCODE_DPAD_UP:
                        case KeyEvent.KEYCODE_DPAD_DOWN:
                        case KeyEvent.KEYCODE_DPAD_LEFT:
                        case KeyEvent.KEYCODE_DPAD_RIGHT:
                        case KeyEvent.KEYCODE_DPAD_CENTER:
                        case KeyEvent.KEYCODE_ENTER:
                        case KeyEvent.KEYCODE_NUMPAD_ENTER:
                        case KeyEvent.KEYCODE_BUTTON_A:
                            if (!isTextInputEditing) {
                                return true;
                            }
                            break;
                        case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                        case KeyEvent.KEYCODE_MEDIA_PLAY:
                        case KeyEvent.KEYCODE_MEDIA_PAUSE:
                        case KeyEvent.KEYCODE_MEDIA_NEXT:
                        case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                        case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                        case KeyEvent.KEYCODE_MEDIA_REWIND:
                            return true;
                    }
                }
            }
        }
        return super.dispatchKeyEvent(event);
    }

    /**
     * Starts local HTTP TV Pairing Server on port 8080.
     */
    private synchronized void startTvPairingServer() {
        if (isServerRunning) return;
        isServerRunning = true;
        new Thread(() -> {
            try {
                pairingServer = new ServerSocket();
                pairingServer.setReuseAddress(true);
                pairingServer.bind(new java.net.InetSocketAddress(PAIRING_PORT));
                Log.i(TAG, "TV Pairing Server listening on port " + PAIRING_PORT);

                while (isServerRunning && pairingServer != null && !pairingServer.isClosed()) {
                    Socket client = pairingServer.accept();
                    handleClientRequest(client);
                }
            } catch (Exception e) {
                if (isServerRunning) {
                    Log.e(TAG, "Pairing server error", e);
                }
            }
        }).start();
    }

    private void stopTvPairingServer() {
        isServerRunning = false;
        try {
            if (pairingServer != null && !pairingServer.isClosed()) {
                pairingServer.close();
            }
        } catch (Exception ignored) {}
    }

    private String readAsciiHeaderLine(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') buf.write(b);
        }
        if (b == -1 && buf.size() == 0) return null;
        return new String(buf.toByteArray(), StandardCharsets.UTF_8);
    }

    private void handleClientRequest(Socket socket) {
        asyncPool.execute(() -> {
            try (InputStream rawIn = socket.getInputStream();
                 OutputStream out = socket.getOutputStream()) {

                String requestLine = readAsciiHeaderLine(rawIn);
                if (requestLine == null) return;

                String[] parts = requestLine.split(" ");
                String method = parts[0];
                String path = parts.length > 1 ? parts[1] : "/";

                int contentLength = 0;
                String rangeHeader = null;
                String line;
                while ((line = readAsciiHeaderLine(rawIn)) != null && !line.isEmpty()) {
                    String lower = line.toLowerCase();
                    if (lower.startsWith("content-length:")) {
                        contentLength = Integer.parseInt(line.substring(15).trim());
                    } else if (lower.startsWith("range:")) {
                        rangeHeader = line.substring(6).trim();
                    }
                }

                if ("POST".equalsIgnoreCase(method) && path.startsWith("/api/pair")) {
                    byte[] body = new byte[Math.max(0, contentLength)];
                    int totalRead = 0;
                    while (totalRead < contentLength) {
                        int r = rawIn.read(body, totalRead, contentLength - totalRead);
                        if (r == -1) break;
                        totalRead += r;
                    }
                    final String rawBody = new String(body, 0, totalRead, StandardCharsets.UTF_8);
                    pendingPairPayload = rawBody;
                    Log.i(TAG, "Received pairing payload (" + totalRead + " bytes)");

                    // Deliver payload directly into WebView via pull mechanism to prevent evaluateJavascript IPC buffer overflow
                    getBridge().getWebView().post(() -> {
                        String js = "(function(){try{var raw=window.AndroidBridge&&window.AndroidBridge.consumePairPayload?window.AndroidBridge.consumePairPayload():'';if(!raw)return;var obj=JSON.parse(raw);if(window.onTvPairReceived){window.onTvPairReceived(obj);}window.dispatchEvent(new CustomEvent('tv-pair-received',{detail:obj}));}catch(e){console.error('Pair parse error',e);}})();";
                        getBridge().getWebView().evaluateJavascript(js, null);
                    });

                    String res = "{\"success\":true,\"message\":\"Paired successfully\"}";
                    byte[] resBytes = res.getBytes(StandardCharsets.UTF_8);
                    String hdr = "HTTP/1.1 200 OK\r\n" +
                            "Content-Type: application/json\r\n" +
                            "Access-Control-Allow-Origin: *\r\n" +
                            "Content-Length: " + resBytes.length + "\r\n\r\n";
                    out.write(hdr.getBytes(StandardCharsets.UTF_8));
                    out.write(resBytes);
                    out.flush();
                } else if ("OPTIONS".equalsIgnoreCase(method)) {
                    String hdr = "HTTP/1.1 204 No Content\r\n" +
                            "Access-Control-Allow-Origin: *\r\n" +
                            "Access-Control-Allow-Methods: GET, POST, HEAD, OPTIONS\r\n" +
                            "Access-Control-Allow-Headers: *\r\n" +
                            "Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type\r\n" +
                            "Connection: close\r\n\r\n";
                    out.write(hdr.getBytes(StandardCharsets.UTF_8));
                    out.flush();
                } else if (("GET".equalsIgnoreCase(method) || "HEAD".equalsIgnoreCase(method)) &&
                        (path.startsWith("/stream") || path.startsWith("/playlist.m3u8") ||
                         path.startsWith("/segment.ts") || path.startsWith("/segment.mp4"))) {
                    handleStreamProxyRequest(method, path, rangeHeader, out);
                } else {
                    // Serve Portal HTML
                    String html = getPortalHtml();
                    byte[] htmlBytes = html.getBytes(StandardCharsets.UTF_8);
                    String hdr = "HTTP/1.1 200 OK\r\n" +
                            "Content-Type: text/html; charset=UTF-8\r\n" +
                            "Content-Length: " + htmlBytes.length + "\r\n\r\n";
                    out.write(hdr.getBytes(StandardCharsets.UTF_8));
                    out.write(htmlBytes);
                    out.flush();
                }
            } catch (Exception e) {
                Log.e(TAG, "Client handle error", e);
            } finally {
                try { socket.close(); } catch (Exception ignored) {}
            }
        });
    }

    /**
     * Local HTTP Stream & HLS Proxy on 127.0.0.1:8080 (/stream?url=...&referer=...)
     * Injects Referer/Origin/User-Agent/Basic-Auth headers, forwards Range requests, and rewrites .m3u8 playlists.
     */
    private void handleStreamProxyRequest(String method, String path, String rangeHeader, OutputStream out) {
        HttpURLConnection conn = null;
        try {
            int qIdx = path.indexOf('?');
            String query = qIdx >= 0 ? path.substring(qIdx + 1) : "";
            String targetUrl = null;
            String referer = null;

            for (String param : query.split("&")) {
                int eq = param.indexOf('=');
                if (eq > 0) {
                    String k = param.substring(0, eq);
                    String v = URLDecoder.decode(param.substring(eq + 1).replace("+", "%2B"), "UTF-8");
                    if ("url".equals(k)) targetUrl = v;
                    else if ("referer".equals(k)) referer = v;
                }
            }

            if (targetUrl == null || targetUrl.isEmpty()) {
                out.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.UTF_8));
                out.flush();
                return;
            }

            // Extract embedded HTTP Basic Auth credentials (e.g. Easynews https://user:pass@members.easynews.com/dl/...)
            String basicAuthHeader = null;
            try {
                URL parsedInitial = new URL(targetUrl);
                String userInfo = parsedInitial.getUserInfo();
                if (userInfo != null && !userInfo.isEmpty()) {
                    String decodedUserInfo = URLDecoder.decode(userInfo.replace("+", "%2B"), "UTF-8");
                    basicAuthHeader = "Basic " + Base64.encodeToString(decodedUserInfo.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
                    int atIdx = targetUrl.indexOf('@');
                    int schemeIdx = targetUrl.indexOf("://");
                    if (atIdx > schemeIdx && schemeIdx > 0) {
                        targetUrl = targetUrl.substring(0, schemeIdx + 3) + targetUrl.substring(atIdx + 1);
                    }
                }
            } catch (Exception ignored) {}

            String initialHost = "";
            try { initialHost = new URL(targetUrl).getHost().toLowerCase(); } catch (Exception ignored) {}
            String currentUrl = targetUrl;
            for (int hop = 0; hop < 6; hop++) {
                URL u = new URL(currentUrl);
                String hopUserInfo = u.getUserInfo();
                if (hopUserInfo != null && !hopUserInfo.isEmpty()) {
                    if (basicAuthHeader == null) {
                        String decodedHopAuth = URLDecoder.decode(hopUserInfo.replace("+", "%2B"), "UTF-8");
                        basicAuthHeader = "Basic " + Base64.encodeToString(decodedHopAuth.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
                    }
                    int atIdx = currentUrl.indexOf('@');
                    int schemeIdx = currentUrl.indexOf("://");
                    if (atIdx > schemeIdx && schemeIdx > 0) {
                        currentUrl = currentUrl.substring(0, schemeIdx + 3) + currentUrl.substring(atIdx + 1);
                        u = new URL(currentUrl);
                    }
                }

                conn = (HttpURLConnection) u.openConnection();
                configureHttpConnection(conn);
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.setRequestMethod("HEAD".equalsIgnoreCase(method) ? "HEAD" : "GET");
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");
                conn.setRequestProperty("Accept", "*/*");
                String currentHost = u.getHost().toLowerCase();
                if (basicAuthHeader != null && (hop == 0 || currentHost.equals(initialHost) || currentHost.endsWith(".easynews.com"))) {
                    conn.setRequestProperty("Authorization", basicAuthHeader);
                }
                if (referer != null && !referer.isEmpty()) {
                    conn.setRequestProperty("Referer", referer);
                    try {
                        URL refU = new URL(referer);
                        String origin = refU.getProtocol() + "://" + refU.getHost() + (refU.getPort() != -1 ? ":" + refU.getPort() : "");
                        conn.setRequestProperty("Origin", origin);
                    } catch (Exception ignored) {}
                }
                if (rangeHeader != null && !rangeHeader.isEmpty()) {
                    conn.setRequestProperty("Range", rangeHeader);
                }

                int status = conn.getResponseCode();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String loc = conn.getHeaderField("Location");
                    conn.disconnect();
                    if (loc == null || loc.isEmpty()) break;
                    currentUrl = new URL(u, loc).toString();
                    continue;
                }
                break;
            }

            if (conn == null) return;
            int status = conn.getResponseCode();
            String contentType = conn.getContentType();
            if (contentType == null || contentType.isEmpty()) {
                contentType = "application/octet-stream";
            }

            boolean isM3u8 = currentUrl.toLowerCase().contains(".m3u8")
                    || path.startsWith("/playlist.m3u8")
                    || contentType.toLowerCase().contains("mpegurl");

            if (isM3u8 && !"HEAD".equalsIgnoreCase(method) && status >= 200 && status < 300) {
                InputStream is = conn.getInputStream();
                String manifestText = new String(readAllBytes(is), StandardCharsets.UTF_8);
                if (manifestText.trim().startsWith("#EXTM3U")) {
                    String rewritten = rewriteM3u8Manifest(manifestText, currentUrl, referer != null ? referer : "");
                    byte[] bodyBytes = rewritten.getBytes(StandardCharsets.UTF_8);
                    String hdr = "HTTP/1.1 200 OK\r\n" +
                            "Content-Type: application/vnd.apple.mpegurl\r\n" +
                            "Access-Control-Allow-Origin: *\r\n" +
                            "Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type\r\n" +
                            "Cache-Control: no-cache\r\n" +
                            "Content-Length: " + bodyBytes.length + "\r\n" +
                            "Connection: close\r\n\r\n";
                    out.write(hdr.getBytes(StandardCharsets.UTF_8));
                    out.write(bodyBytes);
                    out.flush();
                    return;
                }
            }

            String lowerTarget = currentUrl.toLowerCase();
            String lowerPath = path.toLowerCase();
            if (lowerPath.contains("segment.ts")
                    || lowerTarget.contains(".ts")
                    || lowerTarget.contains(".ts.jpg")
                    || lowerTarget.contains(".ts.png")
                    || contentType.contains("video/mp2t")
                    || (lowerPath.contains("segment") && contentType.contains("image/"))) {
                contentType = "video/mp2t";
            } else if (lowerPath.contains("segment.mp4")
                    || lowerTarget.contains(".mp4")
                    || lowerTarget.contains(".m4s")) {
                contentType = "video/mp4";
            } else if (lowerTarget.contains(".mkv")) {
                contentType = "video/x-matroska";
            } else if (lowerTarget.contains(".webm")) {
                contentType = "video/webm";
            } else if (lowerTarget.contains(".mp3")) {
                contentType = "audio/mpeg";
            } else if (lowerTarget.contains(".m4a") || lowerTarget.contains(".m4b") || lowerTarget.contains(".aac")) {
                contentType = "audio/mp4";
            } else if (lowerTarget.contains(".flac")) {
                contentType = "audio/flac";
            } else if (lowerTarget.contains(".ogg") || lowerTarget.contains(".opus")) {
                contentType = "audio/ogg";
            } else if (lowerTarget.contains(".wav")) {
                contentType = "audio/wav";
            }

            StringBuilder hdr = new StringBuilder();
            String statusLine = status == 206 ? "HTTP/1.1 206 Partial Content\r\n"
                    : status == 200 ? "HTTP/1.1 200 OK\r\n"
                    : "HTTP/1.1 " + status + " OK\r\n";
            hdr.append(statusLine);
            hdr.append("Content-Type: ").append(contentType).append("\r\n");
            hdr.append("Access-Control-Allow-Origin: *\r\n");
            hdr.append("Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type\r\n");
            hdr.append("Accept-Ranges: bytes\r\n");

            String contentRange = conn.getHeaderField("Content-Range");
            if (contentRange != null) {
                hdr.append("Content-Range: ").append(contentRange).append("\r\n");
            }
            String contentLen = conn.getHeaderField("Content-Length");
            if (contentLen != null) {
                hdr.append("Content-Length: ").append(contentLen).append("\r\n");
            }
            hdr.append("Connection: close\r\n\r\n");
            out.write(hdr.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();

            if (!"HEAD".equalsIgnoreCase(method)) {
                InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                if (is != null) {
                    byte[] buf = new byte[32768];
                    int n;
                    while ((n = is.read(buf)) != -1) {
                        out.write(buf, 0, n);
                    }
                    out.flush();
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Stream proxy error: " + e.getMessage());
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignored) {}
            }
        }
    }

    private String rewriteM3u8Manifest(String manifest, String baseUrl, String referer) {
        StringBuilder out = new StringBuilder();
        try {
            URL base = new URL(baseUrl);
            String encRef = URLEncoder.encode(referer != null ? referer : "", "UTF-8");
            for (String rawLine : manifest.split("\n")) {
                String trimmed = rawLine.trim();
                if (trimmed.isEmpty()) {
                    out.append("\n");
                    continue;
                }
                if (trimmed.startsWith("#EXT-X-KEY:") || trimmed.startsWith("#EXT-X-MAP:")) {
                    int uriStart = trimmed.indexOf("URI=\"");
                    if (uriStart >= 0) {
                        String after = trimmed.substring(uriStart + 5);
                        int uriEnd = after.indexOf('"');
                        if (uriEnd >= 0) {
                            String rawUri = after.substring(0, uriEnd);
                            try {
                                String resolved = new URL(base, rawUri).toString();
                                String endpoint = (resolved.contains(".m4s") || resolved.contains(".mp4")) ? "/segment.mp4" : "/segment.ts";
                                String proxied = "http://127.0.0.1:" + PAIRING_PORT + endpoint
                                        + "?url=" + URLEncoder.encode(resolved, "UTF-8")
                                        + "&referer=" + encRef;
                                trimmed = trimmed.substring(0, uriStart) + "URI=\"" + proxied + "\"" + after.substring(uriEnd + 1);
                            } catch (Exception ignored) {}
                        }
                    }
                    out.append(trimmed).append("\n");
                    continue;
                }
                if (trimmed.startsWith("#")) {
                    out.append(trimmed).append("\n");
                    continue;
                }
                String resolved;
                try {
                    resolved = new URL(base, trimmed).toString();
                } catch (Exception e) {
                    resolved = trimmed;
                }
                String lower = resolved.toLowerCase();
                boolean isSubM3u8 = lower.contains(".m3u8") || lower.contains("playlist");
                String endpoint = isSubM3u8 ? "/playlist.m3u8"
                        : (lower.contains(".mp4") || lower.contains(".m4s")) ? "/segment.mp4"
                        : "/segment.ts";
                String proxied = "http://127.0.0.1:" + PAIRING_PORT + endpoint
                        + "?url=" + URLEncoder.encode(resolved, "UTF-8")
                        + "&referer=" + encRef;
                out.append(proxied).append("\n");
            }
        } catch (Exception e) {
            return manifest;
        }
        return out.toString();
    }

    private String getPortalHtml() {
        return "<!DOCTYPE html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'>" +
                "<title>RcloneFlix TV Setup</title><style>" +
                "body{background:#090B0E;color:#F3F4F6;font-family:sans-serif;padding:24px 16px;display:flex;flex-direction:column;align-items:center;}" +
                ".box{max-width:440px;width:100%;display:flex;flex-direction:column;gap:18px;}" +
                ".logo{font-size:24px;font-weight:800;color:#E50914;text-align:center;} .logo span{color:#fff;}" +
                ".card{background:#141822;border:1px solid #232A3B;border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:12px;}" +
                ".btn{background:#E50914;color:#fff;border:none;border-radius:8px;padding:12px;font-size:15px;font-weight:600;cursor:pointer;}" +
                "textarea{width:100%;height:80px;background:#000;border:1px solid #232A3B;color:#fff;padding:8px;border-radius:8px;font-family:monospace;resize:none;}" +
                ".msg{padding:12px;border-radius:8px;font-size:14px;display:none;text-align:center;}" +
                ".ok{display:block;background:rgba(16,185,129,0.2);color:#10B981;border:1px solid #10B981;}" +
                ".err{display:block;background:rgba(239,68,68,0.2);color:#f87171;border:1px solid #ef4444;}" +
                "</style></head><body><div class='box'>" +
                "<div class='logo'>RCLONE<span>FLIX</span> TV</div>" +
                "<div id='m' class='msg'></div>" +
                "<div class='card'><strong>Option 1: Upload .rflix Pass File</strong>" +
                "<p style='font-size:12px;color:#9CA3AF;margin:0;'>Select your .rflix pass file from your phone's Downloads or Files.</p>" +
                "<input type='file' id='f' accept='*/*'></div>" +
                "<div class='card'><strong>Option 2: Paste Pass Token Code</strong>" +
                "<textarea id='t' placeholder='Paste pass token code here...'></textarea>" +
                "<button class='btn' onclick='sendT()'>Send to TV</button></div>" +
                "</div><script>" +
                "function show(msg,ok){var m=document.getElementById('m');m.className='msg '+(ok?'ok':'err');m.innerText=msg;}" +
                "function post(type,payload,name){" +
                "show('Sending to TV...',true);" +
                "fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:type,payload:payload,filename:name})})" +
                ".then(r=>r.json()).then(d=>{show('Successfully paired! Your TV is now loading.',true);})" +
                ".catch(e=>{show('Error: '+e.message,false);});" +
                "}" +
                "function sendT(){var v=document.getElementById('t').value.trim();if(!v)return show('Enter a code',false);post('token',v,'token.rflix');}" +
                "document.getElementById('f').onchange=function(e){" +
                "var file=e.target.files[0];if(!file)return;" +
                "var r=new FileReader();" +
                "r.onload=function(){" +
                "var bytes=new Uint8Array(r.result);" +
                "var isRflix=file.name.toLowerCase().endsWith('.rflix')||(bytes.length>=4&&bytes[0]===82&&bytes[1]===70&&bytes[2]===76&&bytes[3]===88);" +
                "if(isRflix){" +
                "var bin='';for(var i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);" +
                "post('pass',btoa(bin),file.name);" +
                "}else{" +
                "var txt=new TextDecoder().decode(bytes);" +
                "post('config',txt,file.name);" +
                "}" +
                "};r.readAsArrayBuffer(file);" +
                "};" +
                "</script></body></html>";
    }

    /**
     * Starts `rclone serve http` on loopback and waits until the socket is accepting connections.
     */
    public synchronized int startRcloneServe(String remoteRoot, int port) {
        if (remoteRoot != null && remoteRoot.toLowerCase().startsWith("streamtape:")) {
            appendLog("warn", "rclone", "Skipping desktop-only streamtape: AList WebDAV remote on Android: " + remoteRoot);
            return -1;
        }
        if (rcloneProcess != null && rcloneProcess.isAlive()
                && remoteRoot != null && remoteRoot.equals(currentServedRoot)
                && port == currentServedPort) {
            return port;
        }
        stopRcloneServe();
        try {
            File rcloneBin = getRcloneBinary();
            File confFile = getRcloneConfigFile();

            ProcessBuilder pb = new ProcessBuilder(
                    rcloneBin.getAbsolutePath(),
                    "serve", "http",
                    remoteRoot,
                    "--addr", "127.0.0.1:" + port,
                    "--config", confFile.getAbsolutePath(),
                    "--no-check-certificate",
                    "--allow-origin", "*",
                    "--read-only",
                    "--no-modtime",
                    "--no-checksum",
                    "--copy-links",
                    "--dir-cache-time", "72h",
                    "--buffer-size", "4M",
                    "--vfs-read-chunk-size", "8M",
                    "--vfs-read-chunk-size-limit", "256M"
            );
            configureProcessBuilder(pb);
            pb.redirectErrorStream(true);
            final Process proc = pb.start();
            rcloneProcess = proc;
            currentServedRoot = remoteRoot;
            currentServedPort = port;

            // Drain stdout/stderr in background so pipe buffer never fills and blocks rclone serve
            asyncPool.execute(() -> {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        appendLog("debug", "rclone-serve", line);
                    }
                } catch (Exception ignored) {}
            });

            // Wait up to 4.5s for 127.0.0.1:port to accept TCP connections
            boolean connected = false;
            long deadline = System.currentTimeMillis() + 4500;
            while (System.currentTimeMillis() < deadline) {
                if (!proc.isAlive()) {
                    appendLog("error", "rclone-serve", "rclone serve exited prematurely with code " + proc.exitValue() + " for " + remoteRoot);
                    return -1;
                }
                try (Socket s = new Socket()) {
                    s.connect(new InetSocketAddress("127.0.0.1", port), 100);
                    connected = true;
                    break;
                } catch (Exception ignored) {
                    try { Thread.sleep(40); } catch (InterruptedException ie) { break; }
                }
            }

            if (!connected) {
                appendLog("error", "rclone-serve", "Timed out waiting for rclone serve on port " + port + " for " + remoteRoot);
                stopRcloneServe();
                return -1;
            }

            appendLog("info", "rclone-serve", "rclone serve http started on 127.0.0.1:" + port + " for " + remoteRoot);
            return port;
        } catch (Exception e) {
            appendLog("error", "rclone-serve", "Failed to start rclone serve: " + e.getMessage());
            return -1;
        }
    }

    public synchronized void stopRcloneServe() {
        if (rcloneProcess != null) {
            try {
                rcloneProcess.destroy();
                if (!rcloneProcess.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) {
                    rcloneProcess.destroyForcibly();
                    rcloneProcess.waitFor(1, java.util.concurrent.TimeUnit.SECONDS);
                }
            } catch (Exception ignored) {
            } finally {
                rcloneProcess = null;
                currentServedRoot = null;
                currentServedPort = -1;
                Log.i(TAG, "rclone process stopped");
            }
        }
    }

    private byte[] readAllBytes(InputStream is) throws Exception {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] data = new byte[16384];
        int nRead;
        while ((nRead = is.read(data, 0, data.length)) != -1) {
            buffer.write(data, 0, nRead);
        }
        return buffer.toByteArray();
    }

    /**
     * JavaScript Interface exposed to WebView as `window.AndroidBridge`.
     */
    public static class AndroidBridge {
        private final MainActivity activity;

        public AndroidBridge(MainActivity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public String getLocalIp() {
            return activity.getLocalIpAddress();
        }

        @JavascriptInterface
        public boolean isTv() {
            return activity.isTvDevice();
        }

        @JavascriptInterface
        public void setTextInputEditing(boolean editing) {
            activity.isTextInputEditing = editing;
        }

        @JavascriptInterface
        public boolean hasStoragePermission() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                if (android.os.Environment.isExternalStorageManager()) {
                    return true;
                }
            }
            return activity.checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE)
                    == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void requestStoragePermission() {
            activity.runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    try {
                        Intent intent = new Intent(
                                android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                                Uri.parse("package:" + activity.getPackageName())
                        );
                        activity.startActivity(intent);
                        return;
                    } catch (Exception ignored) {
                        try {
                            Intent intent = new Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                            activity.startActivity(intent);
                            return;
                        } catch (Exception ignored2) {}
                    }
                }
                activity.requestPermissions(
                        new String[]{
                                android.Manifest.permission.READ_EXTERNAL_STORAGE,
                                android.Manifest.permission.WRITE_EXTERNAL_STORAGE
                        },
                        1001
                );
            });
        }

        @JavascriptInterface
        public String listLocalDirectory(String requestedPath) {
            try {
                File defaultDownloads = android.os.Environment.getExternalStoragePublicDirectory(
                        android.os.Environment.DIRECTORY_DOWNLOADS
                );
                File sdcardRoot = android.os.Environment.getExternalStorageDirectory();
                File appFiles = activity.getFilesDir();

                File targetDir;
                if (requestedPath == null || requestedPath.trim().isEmpty()) {
                    targetDir = (defaultDownloads != null && defaultDownloads.exists())
                            ? defaultDownloads
                            : (sdcardRoot != null && sdcardRoot.exists() ? sdcardRoot : appFiles);
                } else {
                    targetDir = new File(requestedPath.trim());
                }

                if (!targetDir.exists() || !targetDir.isDirectory()) {
                    targetDir = (sdcardRoot != null && sdcardRoot.exists()) ? sdcardRoot : appFiles;
                }

                JSONObject res = new JSONObject();
                res.put("currentPath", targetDir.getAbsolutePath());
                File parent = targetDir.getParentFile();
                res.put("parentPath", (parent != null && parent.canRead()) ? parent.getAbsolutePath() : JSONObject.NULL);
                res.put("hasPermission", hasStoragePermission());

                JSONArray roots = new JSONArray();
                if (defaultDownloads != null) {
                    JSONObject r = new JSONObject();
                    r.put("label", "Downloads");
                    r.put("path", defaultDownloads.getAbsolutePath());
                    roots.put(r);
                }
                if (sdcardRoot != null) {
                    JSONObject r = new JSONObject();
                    r.put("label", "Internal Storage");
                    r.put("path", sdcardRoot.getAbsolutePath());
                    roots.put(r);
                }
                // Detect mounted USB / external storage volumes under /storage
                File storageRoot = new File("/storage");
                File[] storageVolumes = storageRoot.listFiles();
                if (storageVolumes != null) {
                    for (File vol : storageVolumes) {
                        String vn = vol.getName();
                        if (!"emulated".equals(vn) && !"self".equals(vn) && vol.isDirectory() && vol.canRead()) {
                            JSONObject r = new JSONObject();
                            r.put("label", "USB / External (" + vn + ")");
                            r.put("path", vol.getAbsolutePath());
                            roots.put(r);
                        }
                    }
                }
                JSONObject appRoot = new JSONObject();
                appRoot.put("label", "App Storage");
                appRoot.put("path", appFiles.getAbsolutePath());
                roots.put(appRoot);
                res.put("roots", roots);

                File[] children = targetDir.listFiles();
                List<File> fileList = new ArrayList<>();
                if (children != null) {
                    for (File c : children) {
                        if (!c.getName().startsWith(".")) {
                            fileList.add(c);
                        }
                    }
                }

                Collections.sort(fileList, (a, b) -> {
                    boolean aPriority = !a.isDirectory() && (a.getName().toLowerCase().endsWith(".rflix") || a.getName().toLowerCase().endsWith(".conf"));
                    boolean bPriority = !b.isDirectory() && (b.getName().toLowerCase().endsWith(".rflix") || b.getName().toLowerCase().endsWith(".conf"));
                    if (aPriority != bPriority) return aPriority ? -1 : 1;
                    if (a.isDirectory() != b.isDirectory()) return a.isDirectory() ? -1 : 1;
                    return a.getName().compareToIgnoreCase(b.getName());
                });

                JSONArray entries = new JSONArray();
                for (File f : fileList) {
                    JSONObject item = new JSONObject();
                    item.put("name", f.getName());
                    item.put("path", f.getAbsolutePath());
                    item.put("isDir", f.isDirectory());
                    item.put("size", f.isDirectory() ? 0L : f.length());
                    item.put("mtime", f.lastModified());
                    entries.put(item);
                }
                res.put("entries", entries);
                return res.toString();
            } catch (Exception e) {
                try {
                    JSONObject err = new JSONObject();
                    err.put("error", e.getMessage());
                    return err.toString();
                } catch (Exception ignored) {
                    return "{}";
                }
            }
        }

        @JavascriptInterface
        public String readLocalFileBase64(String filePath) {
            try {
                File f = new File(filePath);
                if (!f.exists() || !f.isFile()) return "";
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                try (FileInputStream fis = new FileInputStream(f)) {
                    byte[] buf = new byte[16384];
                    int read;
                    while ((read = fis.read(buf)) != -1) {
                        bos.write(buf, 0, read);
                    }
                }
                return Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
            } catch (Exception e) {
                Log.e(TAG, "readLocalFileBase64 error", e);
                return "";
            }
        }

        @JavascriptInterface
        public void appendNativeLog(String level, String target, String message) {
            activity.appendLog(level, target, message);
        }

        @JavascriptInterface
        public String readNativeLogTail(int lines) {
            return activity.getLogTail(lines);
        }

        @JavascriptInterface
        public int startRclone(String remoteRoot, int port) {
            return activity.startRcloneServe(remoteRoot, port);
        }

        @JavascriptInterface
        public void stopRclone() {
            activity.stopRcloneServe();
        }

        @JavascriptInterface
        public boolean saveRcloneConfig(String content) {
            try {
                File confFile = activity.getRcloneConfigFile();
                try (FileOutputStream fos = new FileOutputStream(confFile)) {
                    fos.write((content != null ? content : "").getBytes(StandardCharsets.UTF_8));
                }
                return true;
            } catch (Exception e) {
                Log.e(TAG, "Failed to save rclone config", e);
                return false;
            }
        }

        @JavascriptInterface
        public String getRcloneConfig() {
            try {
                File confFile = activity.getRcloneConfigFile();
                if (!confFile.exists()) return "";
                try (FileInputStream fis = new FileInputStream(confFile)) {
                    return new String(activity.readAllBytes(fis), StandardCharsets.UTF_8);
                }
            } catch (Exception e) {
                Log.e(TAG, "Failed to read rclone config", e);
                return "";
            }
        }

        @JavascriptInterface
        public boolean writeStorageFile(String filename, String content) {
            try {
                String safeName = filename.replaceAll("[^a-zA-Z0-9._-]", "_");
                File target = new File(activity.getFilesDir(), safeName);
                try (FileOutputStream fos = new FileOutputStream(target)) {
                    fos.write((content != null ? content : "").getBytes(StandardCharsets.UTF_8));
                }
                return true;
            } catch (Exception e) {
                Log.e(TAG, "writeStorageFile failed: " + filename, e);
                return false;
            }
        }

        @JavascriptInterface
        public String readStorageFile(String filename) {
            try {
                String safeName = filename.replaceAll("[^a-zA-Z0-9._-]", "_");
                File target = new File(activity.getFilesDir(), safeName);
                if (!target.exists()) return "";
                try (FileInputStream fis = new FileInputStream(target)) {
                    return new String(activity.readAllBytes(fis), StandardCharsets.UTF_8);
                }
            } catch (Exception e) {
                Log.e(TAG, "readStorageFile failed: " + filename, e);
                return "";
            }
        }

        @JavascriptInterface
        public void setFullscreen(final boolean fullscreen) {
            activity.runOnUiThread(() -> {
                try {
                    activity.applyImmersiveFullscreen();
                    if (fullscreen) {
                        activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                    } else {
                        activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        if (activity.isTvDevice()) {
                            activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                        } else {
                            activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                        }
                    }
                } catch (Exception e) {
                    Log.w(TAG, "setFullscreen error", e);
                }
            });
        }

        @JavascriptInterface
        public void minimizeApp() {
            activity.runOnUiThread(() -> {
                try {
                    activity.moveTaskToBack(true);
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void setPipEligible(final boolean eligible, final int width, final int height) {
            activity.isPipEligible = eligible;
            if (width > 0 && height > 0) {
                activity.pipVideoWidth = width;
                activity.pipVideoHeight = height;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !activity.isTvDevice()) {
                activity.runOnUiThread(() -> {
                    try {
                        if (!activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
                            return;
                        }
                        int w = activity.pipVideoWidth > 0 ? activity.pipVideoWidth : 16;
                        int h = activity.pipVideoHeight > 0 ? activity.pipVideoHeight : 9;
                        float ratio = (float) w / (float) h;
                        if (ratio < 0.42f) { w = 42; h = 100; }
                        else if (ratio > 2.38f) { w = 238; h = 100; }
                        PictureInPictureParams params = new PictureInPictureParams.Builder()
                                .setAspectRatio(new Rational(w, h))
                                .setAutoEnterEnabled(eligible)
                                .build();
                        activity.setPictureInPictureParams(params);
                    } catch (Exception ignored) {}
                });
            }
        }

        @JavascriptInterface
        public boolean enterPip(final int width, final int height) {
            if (width > 0 && height > 0) {
                activity.pipVideoWidth = width;
                activity.pipVideoHeight = height;
            }
            activity.runOnUiThread(() -> activity.enterVideoPip(activity.pipVideoWidth, activity.pipVideoHeight));
            return true;
        }

        @JavascriptInterface
        public void updateMediaSession(
                String title,
                String artist,
                String album,
                double durationSec,
                double positionSec,
                boolean isPlaying,
                String coverUrl
        ) {
            try {
                Intent intent = new Intent(activity, MediaPlaybackService.class);
                intent.setAction(MediaPlaybackService.ACTION_UPDATE);
                intent.putExtra("title", title != null ? title : "RcloneFlix");
                intent.putExtra("artist", artist != null ? artist : "");
                intent.putExtra("album", album != null ? album : "");
                intent.putExtra("durationMs", Math.max(0L, Math.round(durationSec * 1000.0)));
                intent.putExtra("positionMs", Math.max(0L, Math.round(positionSec * 1000.0)));
                intent.putExtra("isPlaying", isPlaying);
                intent.putExtra("coverUrl", coverUrl != null ? coverUrl : "");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !MediaPlaybackService.isServiceRunning()) {
                    activity.startForegroundService(intent);
                } else {
                    activity.startService(intent);
                }
            } catch (Exception e) {
                Log.w(TAG, "updateMediaSession error", e);
            }
        }

        @JavascriptInterface
        public void stopMediaSession() {
            try {
                Intent intent = new Intent(activity, MediaPlaybackService.class);
                intent.setAction(MediaPlaybackService.ACTION_STOP);
                activity.startService(intent);
            } catch (Exception e) {
                Log.w(TAG, "stopMediaSession error", e);
            }
        }

        /**
         * Non-blocking asynchronous task dispatcher so Java network/rclone/file I/O
         * never blocks the Android WebView JavaScript UI thread!
         */
        @JavascriptInterface
        public String consumeAsyncTaskResult(int taskId) {
            String res = activity.pendingTaskResults.remove(taskId);
            return res != null ? res : "{}";
        }

        @JavascriptInterface
        public String consumePairPayload() {
            String p = activity.pendingPairPayload;
            activity.pendingPairPayload = null;
            return p != null ? p : "";
        }

        @JavascriptInterface
        public void runAsyncTask(final int taskId, final String taskType, final String payloadJson) {
            activity.taskPool.execute(() -> {
                String resultJson = "{}";
                try {
                    JSONObject req = (payloadJson != null && !payloadJson.isEmpty()) ? new JSONObject(payloadJson) : new JSONObject();
                    if ("httpFetch".equals(taskType)) {
                        resultJson = httpFetch(
                                req.optString("url", ""),
                                req.optString("method", "GET"),
                                req.optString("headersJson", "{}"),
                                req.optString("body", "")
                        );
                    } else if ("httpDownload".equals(taskType)) {
                        resultJson = httpDownloadToFile(
                                req.optString("url", ""),
                                req.optString("headersJson", "{}"),
                                req.optString("targetPath", "")
                        );
                    } else if ("runRcloneCommand".equals(taskType)) {
                        resultJson = runRcloneCommand(req.optString("argsJson", "[]"));
                    } else if ("startRclone".equals(taskType)) {
                        int port = startRclone(req.optString("remoteRoot", ""), req.optInt("port", 8085));
                        JSONObject r = new JSONObject();
                        r.put("port", port);
                        resultJson = r.toString();
                    } else if ("readRemoteBase64".equals(taskType)) {
                        String b64 = readRemoteBase64(req.optString("remotePath", ""));
                        JSONObject r = new JSONObject();
                        r.put("base64", b64);
                        resultJson = r.toString();
                    } else if ("writeRemoteBase64".equals(taskType)) {
                        boolean ok = writeRemoteBase64(req.optString("remotePath", ""), req.optString("base64", ""));
                        JSONObject r = new JSONObject();
                        r.put("ok", ok);
                        resultJson = r.toString();
                    } else if ("writeStorageFile".equals(taskType)) {
                        boolean ok = writeStorageFile(req.optString("filename", ""), req.optString("content", ""));
                        JSONObject r = new JSONObject();
                        r.put("ok", ok);
                        resultJson = r.toString();
                    } else if ("dbCount".equals(taskType)) {
                        int count = LibraryDbHelper.getInstance(activity).getMediaCount();
                        JSONObject r = new JSONObject();
                        r.put("count", count);
                        resultJson = r.toString();
                    } else if ("dbLoadAll".equals(taskType)) {
                        resultJson = LibraryDbHelper.getInstance(activity).loadAllJson();
                    } else if ("dbLoadItemsPage".equals(taskType)) {
                        resultJson = LibraryDbHelper.getInstance(activity).loadItemsPageJson(
                                req.optInt("offset", 0),
                                req.optInt("limit", 500)
                        );
                    } else if ("dbLoadMeta".equals(taskType)) {
                        resultJson = LibraryDbHelper.getInstance(activity).loadMetaJson();
                    } else if ("dbUpsertItems".equals(taskType)) {
                        boolean ok = LibraryDbHelper.getInstance(activity).upsertItems(req.optString("itemsJson", "[]"));
                        JSONObject r = new JSONObject();
                        r.put("ok", ok);
                        resultJson = r.toString();
                    } else if ("dbUpsertProgressBatch".equals(taskType)) {
                        LibraryDbHelper.getInstance(activity).upsertProgressBatch(req.optString("progressJson", "[]"));
                        JSONObject r = new JSONObject();
                        r.put("ok", true);
                        resultJson = r.toString();
                    } else if ("dbRemoveItems".equals(taskType)) {
                        boolean ok = LibraryDbHelper.getInstance(activity).removeItems(req.optString("idsJson", "[]"));
                        JSONObject r = new JSONObject();
                        r.put("ok", ok);
                        resultJson = r.toString();
                    } else if ("dbClearLibrary".equals(taskType)) {
                        boolean ok = LibraryDbHelper.getInstance(activity).clearLibrary(req.optString("libraryId", ""));
                        JSONObject r = new JSONObject();
                        r.put("ok", ok);
                        resultJson = r.toString();
                    } else if ("dbSetProgress".equals(taskType)) {
                        boolean ok = LibraryDbHelper.getInstance(activity).setProgress(
                                req.optString("itemId", ""),
                                req.optString("data", "{}")
                        );
                        JSONObject r = new JSONObject();
                        r.put("ok", ok);
                        resultJson = r.toString();
                    } else if ("dbRemoveProgress".equals(taskType)) {
                        boolean ok = LibraryDbHelper.getInstance(activity).removeProgress(req.optString("itemId", ""));
                        JSONObject r = new JSONObject();
                        r.put("ok", ok);
                        resultJson = r.toString();
                    } else if ("dbUpsertPlaylists".equals(taskType)) {
                        boolean ok = LibraryDbHelper.getInstance(activity).upsertPlaylists(req.optString("playlistsJson", "[]"));
                        JSONObject r = new JSONObject();
                        r.put("ok", ok);
                        resultJson = r.toString();
                    } else if ("dbRemovePlaylists".equals(taskType)) {
                        boolean ok = LibraryDbHelper.getInstance(activity).removePlaylists(req.optString("idsJson", "[]"));
                        JSONObject r = new JSONObject();
                        r.put("ok", ok);
                        resultJson = r.toString();
                    } else if ("dbSetFavorite".equals(taskType)) {
                        boolean ok = LibraryDbHelper.getInstance(activity).setFavorite(
                                req.optString("itemId", ""),
                                req.optLong("favoritedAt", 0L)
                        );
                        JSONObject r = new JSONObject();
                        r.put("ok", ok);
                        resultJson = r.toString();
                    }
                } catch (Throwable t) {
                    Log.e(TAG, "runAsyncTask error in " + taskType, t);
                    try {
                        JSONObject err = new JSONObject();
                        err.put("ok", false);
                        err.put("error", t.getMessage() != null ? t.getMessage() : t.toString());
                        resultJson = err.toString();
                    } catch (Exception ignored) {}
                }

                activity.pendingTaskResults.put(taskId, resultJson);
                WebView wv = activity.getBridge() != null ? activity.getBridge().getWebView() : null;
                if (wv != null) {
                    wv.post(() -> wv.evaluateJavascript("window.__resolveAndroidAsyncTask && window.__resolveAndroidAsyncTask(" + taskId + ");", null));
                }
            });
        }

        /**
         * Executes arbitrary rclone subcommands with --config and --no-check-certificate automatically injected.
         * @param argsJson JSON array of strings, e.g. ["lsjson", "remote:path"]
         * @return JSON object {"ok": boolean, "stdout": string, "stderr": string}
         */
        @JavascriptInterface
        public String runRcloneCommand(String argsJson) {
            JSONObject res = new JSONObject();
            try {
                JSONArray arr = new JSONArray(argsJson);
                List<String> cmd = new ArrayList<>();
                cmd.add(activity.getRcloneBinary().getAbsolutePath());
                cmd.add("--config");
                cmd.add(activity.getRcloneConfigFile().getAbsolutePath());
                cmd.add("--no-check-certificate");
                for (int i = 0; i < arr.length(); i++) {
                    cmd.add(arr.getString(i));
                }

                ProcessBuilder pb = new ProcessBuilder(cmd);
                activity.configureProcessBuilder(pb);
                final Process p = pb.start();
                java.util.concurrent.Future<byte[]> outFuture = activity.asyncPool.submit(() -> activity.readAllBytes(p.getInputStream()));
                java.util.concurrent.Future<byte[]> errFuture = activity.asyncPool.submit(() -> activity.readAllBytes(p.getErrorStream()));
                int exitCode = p.waitFor();
                String stdout = new String(outFuture.get(), StandardCharsets.UTF_8);
                String stderr = new String(errFuture.get(), StandardCharsets.UTF_8);

                if (exitCode != 0 && !stderr.isEmpty()) {
                    activity.appendLog("error", "rclone", "rclone command failed (" + exitCode + "): " + stderr.trim());
                }

                res.put("ok", exitCode == 0);
                res.put("stdout", stdout);
                res.put("stderr", stderr);
                res.put("code", exitCode);
            } catch (Exception e) {
                try {
                    String errStr = e.getMessage() != null ? e.getMessage() : e.toString();
                    activity.appendLog("error", "rclone", "runRcloneCommand exception: " + errStr);
                    res.put("ok", false);
                    res.put("stdout", "");
                    res.put("stderr", errStr);
                } catch (Exception ignored) {}
            }
            return res.toString();
        }

        @JavascriptInterface
        public String readRemoteBase64(String remotePath) {
            try {
                List<String> cmd = new ArrayList<>();
                cmd.add(activity.getRcloneBinary().getAbsolutePath());
                cmd.add("--config");
                cmd.add(activity.getRcloneConfigFile().getAbsolutePath());
                cmd.add("--no-check-certificate");
                cmd.add("cat");
                cmd.add(remotePath);

                ProcessBuilder pb = new ProcessBuilder(cmd);
                activity.configureProcessBuilder(pb);
                final Process p = pb.start();
                java.util.concurrent.Future<byte[]> outFuture = activity.asyncPool.submit(() -> activity.readAllBytes(p.getInputStream()));
                java.util.concurrent.Future<byte[]> errFuture = activity.asyncPool.submit(() -> activity.readAllBytes(p.getErrorStream()));
                int code = p.waitFor();
                byte[] out = outFuture.get();
                String stderr = new String(errFuture.get(), StandardCharsets.UTF_8);
                if (code != 0) {
                    activity.appendLog("warn", "rclone-cat", "cat failed for " + remotePath + ": " + stderr.trim());
                    return "";
                }
                return Base64.encodeToString(out, Base64.NO_WRAP);
            } catch (Exception e) {
                Log.e(TAG, "readRemoteBase64 error", e);
                return "";
            }
        }

        @JavascriptInterface
        public boolean writeRemoteBase64(String remotePath, String base64Data) {
            File temp = null;
            try {
                byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                temp = File.createTempFile("rclone_upload_", ".tmp", activity.getCacheDir());
                try (FileOutputStream fos = new FileOutputStream(temp)) {
                    fos.write(bytes);
                }

                List<String> cmd = new ArrayList<>();
                cmd.add(activity.getRcloneBinary().getAbsolutePath());
                cmd.add("--config");
                cmd.add(activity.getRcloneConfigFile().getAbsolutePath());
                cmd.add("--no-check-certificate");
                cmd.add("copyto");
                cmd.add(temp.getAbsolutePath());
                cmd.add(remotePath);

                ProcessBuilder pb = new ProcessBuilder(cmd);
                activity.configureProcessBuilder(pb);
                final Process p = pb.start();
                java.util.concurrent.Future<byte[]> outFuture = activity.asyncPool.submit(() -> activity.readAllBytes(p.getInputStream()));
                java.util.concurrent.Future<byte[]> errFuture = activity.asyncPool.submit(() -> activity.readAllBytes(p.getErrorStream()));
                int code = p.waitFor();
                outFuture.get();
                errFuture.get();
                return code == 0;
            } catch (Exception e) {
                Log.e(TAG, "writeRemoteBase64 error", e);
                return false;
            } finally {
                if (temp != null && temp.exists()) {
                    temp.delete();
                }
            }
        }

        /**
         * Performs CORS-free HTTP requests from Android Java for DirectPlay portals & stream extraction.
         */
        @JavascriptInterface
        public String httpFetch(String urlStr, String method, String headersJson, String bodyStr) {
            JSONObject res = new JSONObject();
            HttpURLConnection conn = null;
            try {
                String currentUrl = urlStr;
                String reqMethod = (method != null && !method.isEmpty()) ? method.toUpperCase() : "GET";
                String basicAuthHeader = null;

                for (int hop = 0; hop < 6; hop++) {
                    URL u = new URL(currentUrl);
                    String uInfo = u.getUserInfo();
                    if (uInfo != null && !uInfo.isEmpty()) {
                        if (basicAuthHeader == null) {
                            String decU = URLDecoder.decode(uInfo.replace("+", "%2B"), "UTF-8");
                            basicAuthHeader = "Basic " + Base64.encodeToString(decU.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
                        }
                        int atIdx = currentUrl.indexOf('@');
                        int schemeIdx = currentUrl.indexOf("://");
                        if (atIdx > schemeIdx && schemeIdx > 0) {
                            currentUrl = currentUrl.substring(0, schemeIdx + 3) + currentUrl.substring(atIdx + 1);
                            u = new URL(currentUrl);
                        }
                    }

                    conn = (HttpURLConnection) u.openConnection();
                    activity.configureHttpConnection(conn);
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(20000);
                    conn.setRequestMethod(reqMethod);
                    conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");
                    conn.setRequestProperty("Accept", "*/*");
                    conn.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
                    if (basicAuthHeader != null) {
                        conn.setRequestProperty("Authorization", basicAuthHeader);
                    }

                    if (headersJson != null && !headersJson.isEmpty()) {
                        JSONObject hdrs = new JSONObject(headersJson);
                        Iterator<String> keys = hdrs.keys();
                        while (keys.hasNext()) {
                            String k = keys.next();
                            conn.setRequestProperty(k, hdrs.getString(k));
                        }
                    }

                    if (bodyStr != null && !bodyStr.isEmpty() && ("POST".equals(reqMethod) || "PUT".equals(reqMethod) || "PATCH".equals(reqMethod))) {
                        conn.setDoOutput(true);
                        byte[] outBytes = bodyStr.startsWith("__BASE64__:")
                                ? Base64.decode(bodyStr.substring(11), Base64.DEFAULT)
                                : bodyStr.getBytes(StandardCharsets.UTF_8);
                        try (OutputStream os = conn.getOutputStream()) {
                            os.write(outBytes);
                        }
                    }

                    int status = conn.getResponseCode();
                    if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                        String loc = conn.getHeaderField("Location");
                        conn.disconnect();
                        if (loc == null || loc.isEmpty()) break;
                        currentUrl = new URL(u, loc).toString();
                        if (status == 303) reqMethod = "GET";
                        continue;
                    }
                    break;
                }

                int status = conn.getResponseCode();
                InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                byte[] rawBytes = is != null ? activity.readAllBytes(is) : new byte[0];
                String body = new String(rawBytes, StandardCharsets.UTF_8);

                res.put("ok", status >= 200 && status < 300);
                res.put("status", status);
                res.put("body", body);
                res.put("base64", Base64.encodeToString(rawBytes, Base64.NO_WRAP));
                res.put("url", currentUrl);
                JSONObject respHeaders = new JSONObject();
                List<String> allCookies = new ArrayList<>();
                for (Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
                    if (entry.getKey() != null && entry.getValue() != null && !entry.getValue().isEmpty()) {
                        respHeaders.put(entry.getKey().toLowerCase(), String.join(", ", entry.getValue()));
                        if ("set-cookie".equalsIgnoreCase(entry.getKey())) {
                            allCookies.addAll(entry.getValue());
                        }
                    }
                }
                res.put("headers", respHeaders);
                if (!allCookies.isEmpty()) {
                    res.put("set_cookie", String.join("; ", allCookies));
                }
            } catch (Exception e) {
                try {
                    res.put("ok", false);
                    res.put("status", 0);
                    res.put("body", "");
                    res.put("base64", "");
                    res.put("error", e.getMessage() != null ? e.getMessage() : e.toString());
                } catch (Exception ignored) {}
            } finally {
                if (conn != null) {
                    try { conn.disconnect(); } catch (Exception ignored) {}
                }
            }
            return res.toString();
        }

        @JavascriptInterface
        public boolean openInExternalPlayer(String url, String title) {
            try {
                if (url == null || url.trim().isEmpty()) return false;
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(Uri.parse(url.trim()), "video/*");
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (title != null && !title.isEmpty()) {
                    intent.putExtra("title", title);
                    intent.putExtra("android.intent.extra.TITLE", title);
                }
                activity.startActivity(intent);
                return true;
            } catch (Exception e) {
                Log.w(TAG, "openInExternalPlayer error", e);
                return false;
            }
        }

        @JavascriptInterface
        public String statLocalFile(String path) {
            JSONObject r = new JSONObject();
            try {
                File f = new File(path);
                r.put("exists", f.isFile());
                r.put("size", f.isFile() ? f.length() : 0);
                r.put("path", f.getAbsolutePath());
            } catch (Exception e) {
                try { r.put("exists", false); r.put("error", String.valueOf(e)); } catch (Exception ignored) {}
            }
            return r.toString();
        }

        @JavascriptInterface
        public boolean openDownloadsFolder() {
            try {
                Intent intent = new Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(intent);
                return true;
            } catch (Exception e) {
                Log.w(TAG, "openDownloadsFolder failed", e);
                return false;
            }
        }

        private String httpDownloadToFile(String urlStr, String headersJson, String targetPath) {
            JSONObject r = new JSONObject();
            try {
                File target = new File(targetPath);
                File parent = target.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();
                java.net.HttpURLConnection conn =
                        (java.net.HttpURLConnection) new java.net.URL(urlStr).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(60000);
                JSONObject headers = (headersJson != null && !headersJson.isEmpty())
                        ? new JSONObject(headersJson) : new JSONObject();
                java.util.Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    conn.setRequestProperty(k, headers.optString(k, ""));
                }
                if (headers.optString("User-Agent", "").isEmpty()) {
                    conn.setRequestProperty("User-Agent",
                            "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36");
                }
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    r.put("ok", false);
                    r.put("status", code);
                    r.put("error", "HTTP " + code);
                    conn.disconnect();
                    return r.toString();
                }
                long written = 0;
                java.io.InputStream in = conn.getInputStream();
                java.io.FileOutputStream out = new java.io.FileOutputStream(target);
                try {
                    byte[] buf = new byte[262144];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        written += n;
                    }
                } finally {
                    try { out.close(); } catch (Exception ignored) {}
                    try { in.close(); } catch (Exception ignored) {}
                }
                conn.disconnect();
                r.put("ok", true);
                r.put("status", code);
                r.put("bytes", written);
                r.put("path", target.getAbsolutePath());
            } catch (Exception e) {
                try { r.put("ok", false); r.put("error", String.valueOf(e)); } catch (Exception ignored) {}
            }
            return r.toString();
        }
    }
}
