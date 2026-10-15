import AppKit
import SwiftUI
import Darwin

struct Gauge: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let r = min(rect.width, rect.height) * 0.38
        path.addArc(center: c, radius: r, startAngle: .degrees(135), endAngle: .degrees(405), clockwise: false)
        path.move(to: c)
        path.addLine(to: CGPoint(x: c.x + r * 0.52, y: c.y - r * 0.52))
        return path
    }
}
struct PanelView: View {
    @ObservedObject var model: PanelModel
    @Environment(\.colorScheme) private var scheme
    let openDashboard: () -> Void
    let quit: () -> Void
    private var accent: Color { scheme == .dark ? Color(red: 0.62, green: 0.84, blue: 0.72) : Color(red: 0.21, green: 0.47, blue: 0.40) }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    Gauge().stroke(accent, style: StrokeStyle(lineWidth: 2, lineCap: .round)).frame(width: 25, height: 25)
                    Text("QuotaScope").font(.system(size: 18, weight: .semibold))
                    Spacer()
                    if model.busy || model.historyBusy { ProgressView().controlSize(.small) }
                    Button(action: { Task { await model.update(refresh: true); await model.updateHistory(force: true) } }) {
                        Image(systemName: "arrow.clockwise").frame(width: 24, height: 24)
                    }.buttonStyle(.borderless).disabled(model.busy).help("Refresh allowance and history").accessibilityLabel("Refresh allowance and history")
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        HistoryView(model: model, accent: accent, selection: model.historySelection)
                        Divider()
                        if let window = model.window {
                            HStack(alignment: .firstTextBaseline) {
                                Text(window.title).font(.system(size: 11)).foregroundStyle(.secondary)
                                Spacer()
                                Text("\(window.remaining.formatted(.number.precision(.fractionLength(0...1))))% remaining").font(.system(size: 13, weight: .semibold))
                            }
                            if let reset = window.reset {
                                let date = Date(timeIntervalSince1970: reset)
                                Text(date > context.date ? "Resets \(date.formatted(date: .abbreviated, time: .shortened))" : "Reset time reached · awaiting a reading").font(.system(size: 10)).foregroundStyle(.secondary)
                            }
                        }
                        HStack(spacing: 6) {
                            Circle().fill(healthy(context.date) ? accent : Color.orange).frame(width: 6, height: 6)
                            Text(model.headline(at: context.date)).font(.system(size: 11))
                            Spacer()
                            if let read = model.status?.latestRead { Text("Read \(read, style: .relative) ago").font(.system(size: 10)).foregroundStyle(.secondary) }
                        }
                    }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        .background(accent.opacity(scheme == .dark ? 0.07 : 0.04), in: RoundedRectangle(cornerRadius: 12))
                }.frame(maxHeight: .infinity)
                HStack {
                    Button(action: openDashboard) {
                        HStack { Text("Open dashboard"); Spacer(); Image(systemName: "arrow.up.right") }.padding(.vertical, 5)
                    }.buttonStyle(.borderedProminent).tint(accent).foregroundStyle(scheme == .dark ? Color.black : Color.white)
                    Menu {
                        Text("Monitoring continues while your Mac is awake")
                        Button("Quit menu bar app", action: quit)
                    } label: { Image(systemName: "ellipsis").frame(width: 22, height: 22) }
                    .menuStyle(.borderlessButton).fixedSize().help("Menu bar options")
                }
            }.padding(18).frame(maxWidth: .infinity, maxHeight: .infinity).background(Color(nsColor: .windowBackgroundColor))
        }
    }
    private func healthy(_ date: Date) -> Bool { !model.unavailable && model.status?.collector.enabled == true && model.status?.isFresh(at: date) == true }
}

final class HistoryPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { orderOut(nil) }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var item: NSStatusItem!
    private let panel = HistoryPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    private var outsideClick: Any?
    private var localClick: Any?
    private var model: PanelModel!
    private var timer: Timer?
    private var lockFD: Int32 = -1
    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            guard let resource = Bundle.main.url(forResource: "connection", withExtension: "json") else { throw MonitorError.configuration }
            let connection = try JSONDecoder().decode(AppConnection.self, from: Data(contentsOf: resource))
            let settingsURL = URL(fileURLWithPath: connection.settingsPath)
            let folder = settingsURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            lockFD = open(folder.appendingPathComponent("menu-bar.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
            guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { NSApp.terminate(nil); return }
            var port = connection.port
            if FileManager.default.fileExists(atPath: settingsURL.path) {
                port = try JSONDecoder().decode(ConnectionSettings.self, from: Data(contentsOf: settingsURL)).port ?? port
            }
            model = PanelModel(client: MonitorClient(base: try monitorURL(port: port)))
            NSApp.setActivationPolicy(.accessory)
            item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
            if let button = item.button {
                let image = NSImage(size: NSSize(width: 20, height: 20), flipped: false) { rect in
                    let path = NSBezierPath()
                    path.appendArc(withCenter: NSPoint(x: 10, y: 10), radius: 7, startAngle: -45, endAngle: 225, clockwise: false)
                    path.move(to: NSPoint(x: 10, y: 10)); path.line(to: NSPoint(x: 14, y: 14))
                    path.lineWidth = 1.7; path.lineCapStyle = .round; NSColor.labelColor.setStroke(); path.stroke(); return true
                }
                image.isTemplate = true
                button.image = image; button.toolTip = "QuotaScope — account allowance"
                button.setAccessibilityLabel("QuotaScope")
                button.target = self; button.action = #selector(togglePanel)
            }
            panel.title = "QuotaScope history"
            panel.isReleasedWhenClosed = false
            panel.level = .popUpMenu
            panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
            panel.hasShadow = true; panel.isOpaque = false; panel.backgroundColor = .clear
            panel.delegate = self
            let hosting = NSHostingView(rootView: PanelView(model: model, openDashboard: { [weak self] in
                guard let self else { return }
                if NSWorkspace.shared.open(self.model.dashboardURL) {
                    self.panel.orderOut(nil)
                } else {
                    let alert = NSAlert()
                    alert.messageText = "The dashboard couldn’t open"
                    alert.informativeText = "Open \(self.model.dashboardURL.absoluteString) in your browser. Background monitoring continues."
                    alert.runModal()
                }
            }, quit: { NSApp.terminate(nil) }))
            // The window owns sizing. Async SwiftUI content must never move it above the screen.
            hosting.sizingOptions = []
            hosting.wantsLayer = true; hosting.layer?.cornerRadius = 16; hosting.layer?.masksToBounds = true
            panel.contentView = hosting
            outsideClick = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in self?.panel.orderOut(nil) }
            localClick = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
                if let self, event.window != self.panel, event.window != self.item.button?.window { self.panel.orderOut(nil) }
                return event
            }
            NotificationCenter.default.addObserver(self, selector: #selector(screenChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
            // Status polls every 15s; bounded history at most once a minute while visible.
            timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
                Task { @MainActor in guard let self, self.panel.isVisible else { return }; await self.model.update(); await self.model.updateHistory() }
            }
        } catch {
            let alert = NSAlert(); alert.messageText = "QuotaScope needs setup"; alert.informativeText = "The local connection settings could not be read. Reinstall the menu bar app from the QuotaScope project."; alert.runModal(); NSApp.terminate(nil)
        }
    }
    @objc private func screenChanged() { if panel.isVisible { positionPanel() } }
    private func positionPanel() {
        guard let button = item.button, let window = button.window, let screen = window.screen else { return }
        let anchor = window.convertToScreen(button.convert(button.bounds, to: nil))
        panel.setFrame(panelFrame(anchor: anchor, visible: screen.visibleFrame), display: true)
    }
    @objc private func togglePanel() {
        if panel.isVisible { panel.orderOut(nil); return }
        positionPanel()
        panel.makeKeyAndOrderFront(nil)
        Task { await model.update(); await model.updateHistory(force: true) }
    }
    func windowDidResignKey(_ notification: Notification) { panel.orderOut(nil) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { togglePanel(); return false }
    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        if let outsideClick { NSEvent.removeMonitor(outsideClick) }
        if let localClick { NSEvent.removeMonitor(localClick) }
        NotificationCenter.default.removeObserver(self)
        if lockFD >= 0 { close(lockFD) }
    }
}
@main
struct QuotaScopeApplication {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
