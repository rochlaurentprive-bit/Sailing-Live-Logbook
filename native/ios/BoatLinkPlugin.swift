import Foundation
import Capacitor
import Network
import UIKit
import UserNotifications
import CoreHaptics
import CoreLocation
import AudioToolbox

/// Équivalent iOS du plugin Android « BoatLink » (même nom, mêmes méthodes, mêmes événements).
/// Lecture directe du YDWG-02 (Yacht Devices) en TCP :
/// - la connexion est forcée sur le Wi-Fi du boîtier, même s'il n'a pas Internet
/// - les lignes « RAW » reçues sont envoyées à l'appli (événement "lines")
/// - reconnexion automatique (1 s → 10 s), bus silencieux 60 s = reconnexion
@objc(BoatLinkPlugin)
public class BoatLinkPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "BoatLinkPlugin"
    public let jsName = "BoatLink"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "vibrate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestNotifications", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
    ]

    // Tout l'état réseau est touché uniquement sur cette file série.
    private let q = DispatchQueue(label: "carnet.boatlink")
    private var running = false
    private var gen = 0                      // change à chaque (re)connexion : les rappels périmés sont ignorés
    private var conn: NWConnection?
    private var host = "192.168.4.1"
    private var port: UInt16 = 1456
    private var backoff = 1.0
    private var pending = Data()             // octets reçus, ligne incomplète comprise
    private var out = ""                     // lignes complètes en attente d'envoi à l'appli
    private var lastFlush = Date.distantPast
    private var lastData = Date()
    private var timer: DispatchSourceTimer?
    private var ready = false                // vrai quand le TCP est établi

    private var locMgr: CLLocationManager?   // sert uniquement à garder l'appli active en arrière-plan
    private var hapticEngine: CHHapticEngine?

    // MARK: - Vibration

    @objc func vibrate(_ call: CAPPluginCall) {
        let duration = max(1, call.getInt("duration") ?? 30)
        let amp = call.getInt("amplitude") ?? -1
        let raw = (call.getArray("pattern") ?? []).compactMap { ($0 as? NSNumber)?.doubleValue }
        // Android : motif = [pause, vibre, pause, vibre…] en ms ; sinon une seule vibration.
        var segments: [(start: Double, len: Double)] = []
        if !raw.isEmpty {
            var t = 0.0
            for (i, v) in raw.enumerated() {
                if i % 2 == 1 && v > 0 { segments.append((t, v)) }
                t += max(0, v)
            }
        } else {
            segments = [(0, Double(duration))]
        }
        let intensity = Float(amp > 0 ? min(255, amp) : 255) / 255.0
        if !segments.isEmpty, playHaptics(segments, intensity: intensity) {
            call.resolve(["ok": true])
            return
        }
        // Repli : vibration système fixe (~0,4 s) au début de chaque segment.
        guard !segments.isEmpty else { call.reject("vibrate : motif vide"); return }
        for s in segments {
            DispatchQueue.main.asyncAfter(deadline: .now() + s.start / 1000.0) {
                AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
            }
        }
        call.resolve(["ok": true])
    }

    private func playHaptics(_ segments: [(start: Double, len: Double)], intensity: Float) -> Bool {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return false }
        do {
            if hapticEngine == nil {
                let e = try CHHapticEngine()
                e.stoppedHandler = { [weak self] _ in self?.hapticEngine = nil }
                e.resetHandler = { [weak self] in self?.hapticEngine = nil }
                hapticEngine = e
            }
            guard let engine = hapticEngine else { return false }
            try engine.start()
            let events = segments.map { s in
                CHHapticEvent(
                    eventType: .hapticContinuous,
                    parameters: [
                        CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
                        CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.5),
                    ],
                    relativeTime: s.start / 1000.0,
                    duration: min(s.len, 30000) / 1000.0)   // 30 s maximum par événement continu
            }
            let player = try engine.makePlayer(with: CHHapticPattern(events: events, parameters: []))
            try player.start(atTime: CHHapticTimeImmediate)
            return true
        } catch {
            hapticEngine = nil
            return false
        }
    }

    // MARK: - Notifications / écran

    @objc func requestNotifications(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
            call.resolve()
        }
    }

    @objc func keepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? true
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = on }
        call.resolve()
    }

    // MARK: - Liaison avec le bateau

    @objc func connect(_ call: CAPPluginCall) {
        let h = call.getString("host") ?? "192.168.4.1"
        let p = call.getInt("port") ?? 1456
        q.async {
            self.stopInternal()
            self.host = h
            self.port = UInt16(clamping: p)
            self.backoff = 1.0
            self.running = true
            self.startTimer()
            self.openConnection()
        }
        startKeepAlive()
        call.resolve()
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        q.async { self.stopInternal() }
        stopKeepAlive()
        call.resolve()
    }

    deinit {
        timer?.cancel()
        conn?.cancel()
    }

    private func stopInternal() {   // sur q
        running = false
        gen += 1
        timer?.cancel()
        timer = nil
        conn?.cancel()
        conn = nil
        ready = false
        pending.removeAll()
        out = ""
    }

    private func startTimer() {   // sur q : vide le tampon toutes les 0,5 s et surveille le silence du bus
        timer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now() + 0.5, repeating: 0.5)
        t.setEventHandler { [weak self] in
            guard let self = self, self.running else { return }
            self.flush()
            if self.conn != nil, Date().timeIntervalSince(self.lastData) > 60 { self.drop() }
        }
        timer = t
        t.resume()
    }

    private func openConnection() {   // sur q
        guard running else { return }
        let g = gen
        status("connecting", "\(host):\(port)")
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = 5
        tcp.enableKeepalive = true
        tcp.keepaliveIdle = 10
        let params = NWParameters(tls: nil, tcp: tcp)
        params.requiredInterfaceType = .wifi   // Wi-Fi du boîtier, même sans Internet
        let c = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port) ?? 1456, using: params)
        conn = c
        ready = false
        lastData = Date()
        c.stateUpdateHandler = { [weak self] state in
            guard let self = self, g == self.gen else { return }
            switch state {
            case .ready:
                self.ready = true
                self.backoff = 1.0
                self.lastData = Date()
                self.status("connected", "Wi-Fi du bateau")
                self.receiveNext(c, g)
            case .failed:
                self.drop()
            default:
                break   // .waiting : le système réessaie tout seul ; le délai ci-dessous tranche
            }
        }
        c.start(queue: q)
        // si la connexion n'est pas prête au bout de 8 s (Wi-Fi absent, accès réseau local refusé…), on recommence
        q.asyncAfter(deadline: .now() + 8) { [weak self] in
            guard let self = self, self.running, g == self.gen else { return }
            if !self.ready { self.drop() }
        }
    }

    private func receiveNext(_ c: NWConnection, _ g: Int) {   // sur q
        c.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, isComplete, error in
            guard let self = self, g == self.gen else { return }
            if let d = data, !d.isEmpty { self.handle(d) }
            if error != nil || isComplete {
                self.drop()
                return
            }
            self.receiveNext(c, g)
        }
    }

    private func handle(_ d: Data) {   // sur q
        let now = Date()
        lastData = now
        pending.append(d)
        let nl = UInt8(ascii: "\n")
        while let idx = pending.firstIndex(of: nl) {
            let line = pending[pending.startIndex..<idx]
            out += String(decoding: line, as: UTF8.self)
            out += "\n"
            pending.removeSubrange(pending.startIndex...idx)
        }
        if pending.count > 65536 { pending.removeAll() }   // garde-fou : flux sans fin de ligne
        if now.timeIntervalSince(lastFlush) > 0.2 || out.utf8.count > 6000 { flush() }
    }

    private func flush() {   // sur q
        guard !out.isEmpty else { return }
        let s = out
        out = ""
        lastFlush = Date()
        emit("lines", ["data": s])
    }

    private func drop() {   // sur q : coupure ou échec, nouvelle tentative avec attente croissante
        guard running else { return }
        gen += 1
        let g = gen
        conn?.cancel()
        conn = nil
        ready = false
        pending.removeAll()
        flush()
        status("disconnected", "nouvelle tentative…")
        let wait = backoff
        backoff = min(backoff * 2, 10)
        q.asyncAfter(deadline: .now() + wait) { [weak self] in
            guard let self = self, self.running, g == self.gen else { return }
            self.openConnection()
        }
    }

    private func emit(_ event: String, _ data: [String: Any]) {
        DispatchQueue.main.async { self.notifyListeners(event, data: data) }
    }

    private func status(_ state: String, _ msg: String) {
        emit("status", ["state": state, "msg": msg])
    }

    // MARK: - Maintien en vie en arrière-plan
    // iOS suspend les applis en arrière-plan (donc la lecture TCP). Une appli de navigation peut rester active grâce au
    // mode « Localisation » : on lance un suivi très peu précis, uniquement pour cela (indicateur bleu visible).

    private func startKeepAlive() {
        DispatchQueue.main.async {
            if self.locMgr == nil {
                let lm = CLLocationManager()
                lm.delegate = self
                lm.desiredAccuracy = kCLLocationAccuracyThreeKilometers
                lm.distanceFilter = 500
                lm.pausesLocationUpdatesAutomatically = false
                let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []
                if modes.contains("location") {
                    lm.allowsBackgroundLocationUpdates = true
                    lm.showsBackgroundLocationIndicator = true
                }
                self.locMgr = lm
            }
            if self.locMgr?.authorizationStatus == .notDetermined { self.locMgr?.requestWhenInUseAuthorization() }
            self.locMgr?.startUpdatingLocation()
        }
    }

    private func stopKeepAlive() {
        DispatchQueue.main.async {
            self.locMgr?.stopUpdatingLocation()
            self.locMgr = nil
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {}
    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}
