import AppKit
import SwiftUI
import Darwin
import Combine

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
// Keep these semantic colors aligned with src/style.css in both appearances.
struct PanelTheme {
    let dark: Bool
    private func color(_ light: UInt32, _ darkValue: UInt32) -> Color {
        let value = dark ? darkValue : light
        return Color(red: Double((value >> 16) & 255) / 255,
                     green: Double((value >> 8) & 255) / 255,
                     blue: Double(value & 255) / 255)
    }
    var background: Color { color(0xf6f8f9, 0x151d20) }
    var surface: Color { color(0xffffff, 0x1c272a) }
    var ink: Color { color(0x253238, 0xe3edeb) }
    var muted: Color { color(0x637178, 0x99aaaa) }
    var line: Color { color(0xe8edef, 0x2c3a3d) }
    var accent: Color { color(0x357766, 0x9ed5b7) }
    var soft: Color { color(0xeef5f1, 0x253c34) }
    var warning: Color { color(0x805514, 0xe8c086) }
}

struct DashboardButtonStyle: ButtonStyle {
    let theme: PanelTheme
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .padding(.horizontal, 12).frame(minHeight: 36)
            .foregroundStyle(theme.dark ? theme.background : Color.white)
            .background(theme.accent.opacity(configuration.isPressed ? 0.8 : 1), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct PanelView: View {
    @ObservedObject var model: PanelModel
    @Environment(\.colorScheme) private var scheme
    let openDashboard: () -> Void
    let quit: () -> Void
    private var theme: PanelTheme { PanelTheme(dark: scheme == .dark) }
    private var accent: Color { theme.accent }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    Gauge().stroke(accent, style: StrokeStyle(lineWidth: 2, lineCap: .round)).frame(width: 23, height: 23)
                        .frame(width: 34, height: 34).background(theme.soft, in: RoundedRectangle(cornerRadius: 9))
                    Text("QuotaScope").font(.system(size: 18, weight: .semibold))
                    Spacer()
                    if model.busy || model.historyBusy { ProgressView().controlSize(.small) }
                    Button(action: { Task { await model.update(refresh: true); await model.updateHistory(force: true) } }) {
                        Image(systemName: "arrow.clockwise").foregroundStyle(theme.muted).frame(width: 32, height: 32)
                            .background(theme.surface, in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.line))
                    }.buttonStyle(.borderless).disabled(model.busy).help("Refresh allowance and history").accessibilityLabel("Refresh allowance and history")
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        HistoryView(model: model, theme: theme, selection: model.historySelection)
                        Rectangle().fill(theme.line).frame(height: 1)
                        if let window = model.window {
                            HStack(alignment: .firstTextBaseline) {
                                Text(window.title).font(.system(size: 11)).foregroundStyle(theme.muted)
                                Spacer()
                                Text("\(window.remaining.formatted(.number.precision(.fractionLength(0...1))))% remaining").font(.system(size: 13, weight: .semibold))
                            }
                            if let reset = window.reset {
                                let date = Date(timeIntervalSince1970: reset)
                                Text(date > context.date ? "Resets \(date.formatted(date: .abbreviated, time: .shortened))" : "Reset time reached · awaiting a reading").font(.system(size: 11)).foregroundStyle(theme.muted)
                            }
                        }
                        HStack(spacing: 6) {
                            Circle().fill(healthy(context.date) ? accent : theme.warning).frame(width: 6, height: 6)
                            Text(model.headline(at: context.date)).font(.system(size: 11))
                            Spacer()
                            if let read = model.status?.latestRead { Text("Read \(read, style: .relative) ago").font(.system(size: 11)).foregroundStyle(theme.muted) }
                        }
                    }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                        .background(theme.surface, in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(theme.line))
                }.frame(maxHeight: .infinity)
                HStack {
                    Button(action: openDashboard) {
                        HStack { Text("Open dashboard"); Spacer(); Image(systemName: "arrow.up.right") }
                    }.buttonStyle(DashboardButtonStyle(theme: theme))
                    Menu {
                        Text("Monitoring continues while your Mac is awake")
                        Button("Quit menu bar app", action: quit)
                    } label: { Image(systemName: "ellipsis").foregroundStyle(theme.muted).frame(width: 28, height: 32) }
                    .menuStyle(.borderlessButton).fixedSize().help("Menu bar options")
                }
            }.padding(18).frame(maxWidth: .infinity, maxHeight: .infinity).foregroundStyle(theme.ink).tint(accent).background(theme.background)
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
    private var statusChanges: AnyCancellable?
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
            // Reserve room for 100% so updates never shift neighboring menu items.
            item = NSStatusBar.system.statusItem(withLength: 52)
            if let button = item.button {
                button.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
                button.imagePosition = .noImage
                button.target = self; button.action = #selector(togglePanel)
            }
            updateMenuBar()
            // Receive after @Published mutations, including refreshes and window selection in the panel.
            statusChanges = model.objectWillChange.receive(on: RunLoop.main).sink { [weak self] _ in self?.updateMenuBar() }
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
            NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(woke), name: NSWorkspace.didWakeNotification, object: nil)
            // Lightweight local status stays current with the panel closed. History is visible-only.
            timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
                Task { @MainActor in await self?.poll() }
            }
            Task { await poll() }
        } catch {
            let alert = NSAlert(); alert.messageText = "QuotaScope needs setup"; alert.informativeText = "The local connection settings could not be read. Reinstall the menu bar app from the QuotaScope project."; alert.runModal(); NSApp.terminate(nil)
        }
    }
    private func updateMenuBar() {
        guard let button = item?.button else { return }
        let reading = model.menuBarReading()
        button.title = reading.title
        button.toolTip = "\(reading.accessibilityLabel)\nClick for allowance history"
        button.setAccessibilityLabel(reading.accessibilityLabel)
    }
    private func poll() async {
        updateMenuBar() // Expire an old reading even while a request is pending.
        await model.poll(historyVisible: panel.isVisible)
        updateMenuBar()
    }
    @objc private func woke() {
        updateMenuBar()
        Task { await poll() }
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
        statusChanges?.cancel()
        if let outsideClick { NSEvent.removeMonitor(outsideClick) }
        if let localClick { NSEvent.removeMonitor(localClick) }
        NotificationCenter.default.removeObserver(self)
        NSWorkspace.shared.notificationCenter.removeObserver(self)
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
