import AppKit
import CryptoKit
import Foundation
import Security

private struct AgentHostDiscovery: Decodable {
    let version: Int
    let host: String
    let port: Int
    let origin: String
    let native_launch_secret: String
}

private struct NativeLaunchResponse: Decodable {
    let bootstrap_url: String
    let response_proof: String
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var statusMenuItem: NSMenuItem?
    private var openControlCenterItem: NSMenuItem?
    private var isOpeningControlCenter = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMenuBar()
        openControlCenter(nil)
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        openControlCenter(nil)
        return true
    }

    private func configureMenuBar() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            let image = NSImage(
                systemSymbolName: "link.circle.fill",
                accessibilityDescription: "Norns Local Agent"
            )
            image?.isTemplate = true
            button.image = image
            if image == nil {
                button.title = "N"
            }
            button.toolTip = "Norns Local Agent"
        }

        let menu = NSMenu()
        let titleItem = NSMenuItem(title: "Norns Local Agent", action: nil, keyEquivalent: "")
        titleItem.isEnabled = false
        menu.addItem(titleItem)

        let status = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        menu.addItem(.separator())

        let openItem = NSMenuItem(
            title: "Open Local Control Center",
            action: #selector(openControlCenter(_:)),
            keyEquivalent: ""
        )
        openItem.target = self
        openItem.isEnabled = false
        menu.addItem(openItem)

        let websiteItem = NSMenuItem(
            title: "Open The Norns",
            action: #selector(openWebsite(_:)),
            keyEquivalent: ""
        )
        websiteItem.target = self
        menu.addItem(websiteItem)
        menu.addItem(.separator())

        let quitItem = NSMenuItem(
            title: "Quit Norns Local Agent",
            action: #selector(quitLocalAgent(_:)),
            keyEquivalent: "q"
        )
        quitItem.target = self
        menu.addItem(quitItem)

        item.menu = menu
        statusItem = item
        statusMenuItem = status
        openControlCenterItem = openItem
    }

    @objc private func openControlCenter(_ sender: Any?) {
        guard !isOpeningControlCenter else { return }
        isOpeningControlCenter = true
        statusMenuItem?.title = "Starting local service…"
        openControlCenterItem?.isEnabled = false

        DispatchQueue.global(qos: .userInitiated).async {
            // The shell action is idempotent for the installed version and
            // upgrades an older launch service before opening its Control
            // Center. Active work is left alone when the versions already
            // match.
            let result = self.ensureAgentHost()
            let controlCenter =
                result.status == 0 ? self.waitForControlCenterURL(attempts: 40) : nil

            DispatchQueue.main.async {
                self.isOpeningControlCenter = false
                if let controlCenter {
                    self.statusMenuItem?.title = "Local service running"
                    self.openControlCenterItem?.isEnabled = true
                    NSWorkspace.shared.open(controlCenter)
                    return
                }
                self.statusMenuItem?.title = "Local service unavailable"
                self.openControlCenterItem?.isEnabled = true
                self.showAlert(
                    title: "Norns Local Agent could not open",
                    message: result.message.isEmpty
                        ? "The local Control Center did not respond. Reinstall Norns Local Agent and try again."
                        : result.message
                )
            }
        }
    }

    @objc private func openWebsite(_ sender: Any?) {
        if let url = URL(string: "https://thenorns.up.railway.app") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func quitLocalAgent(_ sender: Any?) {
        statusMenuItem?.title = "Stopping…"
        openControlCenterItem?.isEnabled = false
        DispatchQueue.global(qos: .userInitiated).async {
            let result = self.runAgentAction("stop")
            DispatchQueue.main.async {
                if result.status == 0 {
                    NSApp.terminate(nil)
                    return
                }
                self.statusMenuItem?.title = "Local service running"
                self.openControlCenterItem?.isEnabled = true
                self.showAlert(
                    title: "Norns Local Agent could not quit",
                    message: result.message.isEmpty
                        ? "The local service could not be stopped."
                        : result.message
                )
            }
        }
    }

    private func ensureAgentHost() -> (status: Int32, message: String) {
        return runAgentAction("open")
    }

    private func runAgentAction(_ action: String) -> (status: Int32, message: String) {
        guard let resourceURL = Bundle.main.resourceURL else {
            return (1, "The installed app is incomplete. Reinstall Norns Local Agent.")
        }
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [resourceURL.appendingPathComponent("agent.sh").path, action]
        process.standardOutput = output
        process.standardError = output
        do {
            try process.run()
            process.waitUntilExit()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            let message = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return (process.terminationStatus, String(message.prefix(800)))
        } catch {
            return (1, "Norns Local Agent could not complete that action. Reinstall it and try again.")
        }
    }

    private func waitForControlCenterURL(attempts: Int) -> URL? {
        for _ in 0..<attempts {
            if let url = requestControlCenterURL() {
                return url
            }
            Thread.sleep(forTimeInterval: 0.125)
        }
        return nil
    }

    private func requestControlCenterURL() -> URL? {
        let discoveryURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".norns/runner-1/agent-host.json")
        guard
            let data = try? Data(contentsOf: discoveryURL),
            let discovery = try? JSONDecoder().decode(AgentHostDiscovery.self, from: data),
            discovery.version == 1,
            discovery.host == "127.0.0.1" || discovery.host == "::1",
            (1...65_535).contains(discovery.port),
            discovery.native_launch_secret.range(
                of: #"^[A-Za-z0-9_-]{43}$"#,
                options: .regularExpression
            ) != nil,
            let originURL = URL(string: discovery.origin),
            originURL.scheme == "http",
            originURL.host == discovery.host,
            originURL.port == discovery.port,
            originURL.user == nil,
            originURL.password == nil,
            originURL.query == nil,
            originURL.fragment == nil,
            originURL.path.isEmpty,
            let endpoint = URL(string: "/api/session/native-launch", relativeTo: originURL)
        else {
            return nil
        }
        guard
            let nativeKeyData = decodeBase64Url(discovery.native_launch_secret),
            nativeKeyData.count == 32,
            let requestID = randomBase64UrlIdentifier()
        else {
            return nil
        }
        let requestTranscript = nativeLaunchTranscript(
            purpose: "norns:agent-host-native-launch-request:v1",
            fields: [
                ("origin", discovery.origin),
                ("request_id", requestID),
            ]
        )
        let requestProof = encodeBase64Url(Data(HMAC<SHA256>.authenticationCode(
            for: Data(requestTranscript.utf8),
            using: SymmetricKey(data: nativeKeyData)
        )))

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(discovery.origin, forHTTPHeaderField: "Origin")
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: [
                "request_id": requestID,
                "request_proof": requestProof,
            ]
        )

        let semaphore = DispatchSemaphore(value: 0)
        var responseData: Data?
        var responseStatus: Int?
        URLSession.shared.dataTask(with: request) { data, response, _ in
            responseData = data
            responseStatus = (response as? HTTPURLResponse)?.statusCode
            semaphore.signal()
        }.resume()
        guard semaphore.wait(timeout: .now() + 2) == .success,
              responseStatus == 200,
              let responseData,
              responseData.count <= 8_192,
              let response = try? JSONDecoder().decode(NativeLaunchResponse.self, from: responseData),
              let bootstrapURL = URL(string: response.bootstrap_url),
              bootstrapURL.scheme == originURL.scheme,
              bootstrapURL.host == originURL.host,
              bootstrapURL.port == originURL.port,
              bootstrapURL.path == "/",
              bootstrapURL.query == nil,
              bootstrapURL.fragment?.hasPrefix("bootstrap=") == true,
              let responseProof = decodeBase64Url(response.response_proof),
              responseProof.count == 32
        else {
            return nil
        }
        let responseTranscript = nativeLaunchTranscript(
            purpose: "norns:agent-host-native-launch-response:v1",
            fields: [
                ("origin", discovery.origin),
                ("request_id", requestID),
                ("bootstrap_url", response.bootstrap_url),
            ]
        )
        guard HMAC<SHA256>.isValidAuthenticationCode(
            responseProof,
            authenticating: Data(responseTranscript.utf8),
            using: SymmetricKey(data: nativeKeyData)
        ) else {
            return nil
        }
        return bootstrapURL
    }

    private func nativeLaunchTranscript(
        purpose: String,
        fields: [(String, String)]
    ) -> String {
        var transcript = "\(purpose)\n"
        for (name, value) in fields {
            transcript += "\(name):\(value.lengthOfBytes(using: .utf8)):\(value)\n"
        }
        return transcript
    }

    private func randomBase64UrlIdentifier() -> String? {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            return nil
        }
        return encodeBase64Url(Data(bytes))
    }

    private func decodeBase64Url(_ value: String) -> Data? {
        var base64 = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        return Data(base64Encoded: base64)
    }

    private func encodeBase64Url(_ value: Data) -> String {
        return value.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func showAlert(title: String, message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = title.contains("could not") ? .warning : .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
