import AppKit
import SwiftUI

// Offscreen renderer for the menu bar panel, for visual review without screen recording access.
// Build: xcrun swiftc -D QUOTASCOPE_SNAPSHOT macos/QuotaModel.swift macos/HistoryModel.swift macos/QuotaScope.swift macos/HistoryView.swift macos/Snapshot.swift -o snapshot -framework AppKit -framework SwiftUI
// Run:   snapshot <output folder> [port]
// Writes <scenario>-<appearance>.png at 2x for the live service state and for a delayed-history state.

/// Fails analysis reads while leaving lightweight status reads untouched, to render the delayed-history state.
final class HistoryFailureProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.path.hasPrefix("/api/state") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
func renderPanel(model: PanelModel, dark: Bool, to url: URL) throws {
    let size = NSSize(width: 440, height: 560)
    let hosting = NSHostingView(rootView: PanelView(model: model, openDashboard: {}, quit: {}))
    hosting.sizingOptions = []
    hosting.frame = NSRect(origin: .zero, size: size)
    hosting.wantsLayer = true
    hosting.layer?.cornerRadius = 16
    hosting.layer?.masksToBounds = true
    let window = NSWindow(contentRect: NSRect(origin: NSPoint(x: -6000, y: -6000), size: size), styleMask: [.borderless], backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.contentView = hosting
    window.orderFront(nil)
    hosting.layoutSubtreeIfNeeded()
    window.displayIfNeeded()
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * 2), pixelsHigh: Int(size.height * 2), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = size
    hosting.cacheDisplay(in: hosting.bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else { throw MonitorError.response }
    try png.write(to: url)
    window.orderOut(nil)
}

/// Let SwiftUI and AppKit finish layout and async updates before drawing.
@MainActor
func settle(_ seconds: Double) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
}

@main
struct Snapshot {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        Task { @MainActor in
            do { try await run() } catch { fputs("snapshot failed: \(error)\n", stderr); exit(1) }
            exit(0)
        }
        app.run()
    }
    @MainActor
    static func run() async throws {
        let arguments = CommandLine.arguments
        guard arguments.count >= 2 else { fputs("usage: snapshot <output folder> [port]\n", stderr); exit(2) }
        let folder = URL(fileURLWithPath: arguments[1])
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let port = arguments.count > 2 ? Int(arguments[2]) ?? 4317 : 4317
        let base = try monitorURL(port: port)
        let failing = URLSessionConfiguration.ephemeral
        failing.protocolClasses = [HistoryFailureProtocol.self]
        failing.requestCachePolicy = .reloadIgnoringLocalCacheData
        let scenarios: [(name: String, session: URLSession?)] = [
            ("live", nil),
            ("history-delayed", URLSession(configuration: failing, delegate: NoRedirects(), delegateQueue: nil)),
        ]
        for scenario in scenarios {
            let model = PanelModel(client: MonitorClient(base: base, session: scenario.session))
            await model.update()
            await model.updateHistory(force: true)
            settle(1.0)
            for dark in [true, false] {
                let file = folder.appendingPathComponent("\(scenario.name)-\(dark ? "dark" : "light").png")
                try renderPanel(model: model, dark: dark, to: file)
                settle(0.3)
                print("wrote \(file.path)")
            }
        }
    }
}
