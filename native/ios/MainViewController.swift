import UIKit
import Capacitor

/// Contrôleur principal : enregistre le plugin local « BoatLink » (il n'est pas dans un paquet npm).
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(BoatLinkPlugin())
    }
}
