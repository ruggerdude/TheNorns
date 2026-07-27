import AppKit
import Carbon.HIToolbox
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var pairingStarted = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleGetURL(event:replyEvent:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self, !self.pairingStarted else { return }
            self.showAlert(
                title: "Norns Local Agent is installed",
                message: "Return to The Norns, open Connections, and choose Connect installed agent."
            )
            NSApp.terminate(nil)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        NSAppleEventManager.shared().removeEventHandler(
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    @objc private func handleGetURL(
        event: NSAppleEventDescriptor,
        replyEvent: NSAppleEventDescriptor
    ) {
        guard
            !pairingStarted,
            let pairingURI = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
            pairingURI.hasPrefix("norns-agent://pair?")
        else {
            return
        }
        pairingStarted = true
        NSApp.activate(ignoringOtherApps: true)

        DispatchQueue.global(qos: .userInitiated).async {
            let result = self.runAgent(pairingURI: pairingURI)
            DispatchQueue.main.async {
                if result.status == 0 {
                    self.showAlert(
                        title: "This Mac is connected",
                        message: "Return to The Norns to choose or create your local project folder."
                    )
                } else {
                    self.showAlert(
                        title: "The Mac could not be connected",
                        message: result.message.isEmpty
                            ? "Return to The Norns and create a fresh connection link."
                            : result.message
                    )
                }
                NSApp.terminate(nil)
            }
        }
    }

    private func runAgent(pairingURI: String) -> (status: Int32, message: String) {
        guard let resourceURL = Bundle.main.resourceURL else {
            return (1, "The installed app is incomplete. Reinstall Norns Local Agent.")
        }
        let script = resourceURL.appendingPathComponent("agent.sh").path
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [script, "pair", pairingURI]
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
            return (1, "Norns Local Agent could not start. Reinstall it and try again.")
        }
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
