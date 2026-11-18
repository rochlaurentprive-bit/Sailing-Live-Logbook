package com.carnetdebord.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Handler;
import android.media.AudioAttributes;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;

/**
 * Lecture directe du YDWG-02 (Yacht Devices) en TCP.
 * - la connexion passe par le Wi-Fi du boîtier même s'il n'a pas Internet (le réseau mobile reste utilisé pour la météo)
 * - les lignes « RAW » reçues sont envoyées à l'appli (événement "lines")
 * - reconnexion automatique
 */
@CapacitorPlugin(
        name = "BoatLink",
        permissions = {@Permission(strings = {Manifest.permission.POST_NOTIFICATIONS}, alias = "notifications")}
)
public class BoatLinkPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Object lock = new Object();
    private volatile boolean running = false;
    private volatile Network wifi = null;
    private volatile Socket socket = null;
    private Thread worker = null;
    private ConnectivityManager.NetworkCallback netCb = null;
    private String host = "192.168.4.1";
    private int port = 1456;

    /** Vibration directe (usage « alarme » : fonctionne même si le retour tactile système est coupé). */
    @PluginMethod
    public void vibrate(PluginCall call) {
        try {
            Context c = getContext();
            Vibrator v;
            if (Build.VERSION.SDK_INT >= 31) {
                VibratorManager vm = (VibratorManager) c.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                v = vm.getDefaultVibrator();
            } else {
                v = (Vibrator) c.getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (v == null || !v.hasVibrator()) {
                call.reject("pas de vibreur sur cet appareil");
                return;
            }
            int ms = call.getInt("duration", 30);
            org.json.JSONArray arr = call.getArray("pattern");
            VibrationEffect fx;
            if (arr != null && arr.length() > 0) {
                long[] pat = new long[arr.length()];
                for (int i = 0; i < pat.length; i++) pat[i] = arr.optLong(i, 0);
                fx = VibrationEffect.createWaveform(pat, -1);
            } else {
                int amp = call.getInt("amplitude", -1);
                fx = VibrationEffect.createOneShot(Math.max(1, ms), (amp > 0 && v.hasAmplitudeControl()) ? Math.min(255, amp) : VibrationEffect.DEFAULT_AMPLITUDE);
            }
            AudioAttributes aa = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
            v.vibrate(fx, aa);
            JSObject r = new JSObject();
            r.put("ok", true);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("vibrate : " + e.getMessage());
        }
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notifCallback");
        } else {
            call.resolve();
        }
    }

    @PermissionCallback
    private void notifCallback(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean on = call.getBoolean("on", true);
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    @PluginMethod
    public void connect(PluginCall call) {
        stopInternal();
        host = call.getString("host", "192.168.4.1");
        Integer p = call.getInt("port", 1456);
        port = p == null ? 1456 : p;
        Context ctx = getContext();
        Intent svc = new Intent(ctx, BoatService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(svc);
        else ctx.startService(svc);
        requestWifi();
        running = true;
        worker = new Thread(this::loop, "boatlink");
        worker.start();
        call.resolve();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        stopInternal();
        getContext().stopService(new Intent(getContext(), BoatService.class));
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopInternal();
        super.handleOnDestroy();
    }

    private void requestWifi() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkRequest req = new NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build();
            netCb = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    wifi = network;
                }

                @Override
                public void onLost(Network network) {
                    if (network.equals(wifi)) wifi = null;
                }
            };
            cm.requestNetwork(req, netCb);
        } catch (Exception e) {
            netCb = null;
        }
    }

    private void stopInternal() {
        running = false;
        synchronized (lock) {
            if (socket != null) {
                try {
                    socket.close();
                } catch (Exception ignored) {
                }
                socket = null;
            }
        }
        if (worker != null) {
            worker.interrupt();
            worker = null;
        }
        if (netCb != null) {
            try {
                ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
                cm.unregisterNetworkCallback(netCb);
            } catch (Exception ignored) {
            }
            netCb = null;
        }
        wifi = null;
    }

    private void emit(final String event, final JSObject data) {
        main.post(() -> notifyListeners(event, data));
    }

    private void status(String state, String msg) {
        JSObject o = new JSObject();
        o.put("state", state);
        o.put("msg", msg);
        emit("status", o);
    }

    private void flush(StringBuilder out) {
        if (out.length() == 0) return;
        JSObject o = new JSObject();
        o.put("data", out.toString());
        out.setLength(0);
        emit("lines", o);
    }

    private void loop() {
        long backoff = 1000;
        while (running) {
            Socket s = null;
            try {
                status("connecting", host + ":" + port);
                // on laisse 4 s à Android pour nous donner le réseau Wi-Fi du boîtier
                long t0 = System.currentTimeMillis();
                while (running && wifi == null && System.currentTimeMillis() - t0 < 4000) Thread.sleep(200);
                Network n = wifi;
                s = (n != null) ? n.getSocketFactory().createSocket() : new Socket();
                s.connect(new InetSocketAddress(host, port), 5000);
                s.setSoTimeout(5000);
                synchronized (lock) {
                    socket = s;
                }
                status("connected", n != null ? "Wi-Fi du bateau" : "réseau par défaut");
                backoff = 1000;

                InputStream in = s.getInputStream();
                byte[] buf = new byte[4096];
                StringBuilder pending = new StringBuilder();
                StringBuilder out = new StringBuilder();
                long lastFlush = 0;
                long lastData = System.currentTimeMillis();
                while (running) {
                    int len;
                    try {
                        len = in.read(buf);
                    } catch (SocketTimeoutException e) {
                        flush(out);
                        if (System.currentTimeMillis() - lastData > 60000) break;   // bus silencieux depuis 1 min : on reconnecte
                        continue;
                    }
                    if (len < 0) break;
                    long now = System.currentTimeMillis();
                    lastData = now;
                    pending.append(new String(buf, 0, len, "US-ASCII"));
                    int idx;
                    while ((idx = pending.indexOf("\n")) >= 0) {
                        out.append(pending, 0, idx).append('\n');
                        pending.delete(0, idx + 1);
                    }
                    if (now - lastFlush > 200 || out.length() > 6000) {
                        flush(out);
                        lastFlush = now;
                    }
                }
                flush(out);
            } catch (InterruptedException e) {
                break;
            } catch (Exception e) {
                // échec de connexion ou coupure : on réessaie ci-dessous
            } finally {
                synchronized (lock) {
                    socket = null;
                }
                if (s != null) {
                    try {
                        s.close();
                    } catch (Exception ignored) {
                    }
                }
            }
            if (!running) break;
            status("disconnected", "nouvelle tentative…");
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                break;
            }
            backoff = Math.min(backoff * 2, 10000);
        }
    }
}
