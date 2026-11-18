package com.carnetdebord.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BoatLinkPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onPause() {
        super.onPause();
        // garde le JavaScript actif écran éteint (enregistrement des trajets)
        try {
            getBridge().getWebView().resumeTimers();
        } catch (Exception ignored) {
        }
    }
}
