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
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 10) {
                    Gauge().stroke(accent, style: StrokeStyle(lineWidth: 2, lineCap: .round)).frame(width: 28, height: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("QuotaScope").font(.system(size: 18, weight: .semibold))
                        Text("Room to build.").font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(action: { Task { await model.update(refresh: true) } }) {
                        Image(systemName: "arrow.clockwise").frame(width: 26, height: 26)
                    }.buttonStyle(.borderless).disabled(model.busy).help("Refresh account allowance").accessibilityLabel("Refresh allowance")
                }
                HStack(spacing: 7) {
                    Circle().fill(healthy(context.date) ? accent : Color.orange).frame(width: 6, height: 6)
                    Text(model.headline(at: context.date)).font(.system(size: 12, weight: .medium))
                    if model.busy { Spacer(); ProgressView().controlSize(.small) }
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if let status = model.status, !status.windows.isEmpty {
                            ForEach(status.windows) { window in
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(window.title).font(.system(size: 13, weight: .semibold))
                                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                                        Text(window.remaining, format: .number.precision(.fractionLength(0...1))).font(.system(size: 38, weight: .medium, design: .rounded))
                                        Text("% remaining").font(.system(size: 12)).foregroundStyle(.secondary)
                                    }
                                    ProgressView(value: window.remaining, total: 100).tint(accent).accessibilityLabel("Remaining allowance")
                                    if let reset = window.reset {
                                        let resetDate = Date(timeIntervalSince1970: reset)
                                        if resetDate > context.date {
                                            Text("Resets in \(resetDate, style: .relative)").font(.system(size: 11)).foregroundStyle(.secondary)
                                        } else {
                                            Text("Reset time reached · awaiting a reading").font(.system(size: 11)).foregroundStyle(.secondary)
                                        }
                                    }
                                    Text("Read \(Date(timeIntervalSince1970: window.at / 1000), style: .relative) ago\(healthy(context.date) ? "" : " · Stale")")
                                        .font(.system(size: 10)).foregroundStyle(.secondary)
                                }
                                .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                                .background(accent.opacity(scheme == .dark ? 0.10 : 0.07), in: RoundedRectangle(cornerRadius: 12))
                            }
                        } else {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(model.unavailable ? "The background monitor isn’t reachable." : "Your first allowance reading will appear here.").font(.system(size: 13, weight: .medium))
                                Text("Open the dashboard to check setup or connection details.").font(.system(size: 12)).foregroundStyle(.secondary)
                            }.padding(.vertical, 12)
                        }
                        if model.unavailable {
                            Text("Saved readings may be out of date. The panel reconnects automatically.").font(.system(size: 11)).foregroundStyle(.secondary)
                            Button("Try connecting again") { Task { await model.update() } }.disabled(model.busy)
                        }
                    }
                }.frame(maxHeight: .infinity)
                Button(action: openDashboard) {
                    HStack { Text("Open dashboard"); Spacer(); Image(systemName: "arrow.up.right") }.padding(.vertical, 5)
                }.buttonStyle(.borderedProminent).tint(accent).foregroundStyle(scheme == .dark ? Color.black : Color.white)
                HStack(alignment: .top) {
                    Text("Monitoring continues when this panel closes.\nYour Mac must be awake.").font(.system(size: 10)).foregroundStyle(.secondary)
                    Spacer()
                    Menu {
                        Button("Quit menu bar app", action: quit)
                        Text("Background monitoring stays on")
                    } label: { Image(systemName: "ellipsis").frame(width: 22, height: 22) }
                    .menuStyle(.borderlessButton).fixedSize().help("Menu bar options")
                }
            }.padding(22).frame(width: 360, height: (model.status?.windows.count ?? 1) > 1 ? 600 : 450).background(Color(nsColor: .windowBackgroundColor))
        }
    }
    private func healthy(_ date: Date) -> Bool { !model.unavailable && model.status?.collector.enabled == true && model.status?.isFresh(at: date) == true }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var item: NSStatusItem!
    private let popover = NSPopover()
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
            popover.behavior = .transient
            popover.delegate = self
            popover.contentViewController = NSHostingController(rootView: PanelView(model: model, openDashboard: { [weak self] in
                guard let self else { return }
                if NSWorkspace.shared.open(self.model.dashboardURL) {
                    self.popover.performClose(nil)
                } else {
                    let alert = NSAlert()
                    alert.messageText = "The dashboard couldn’t open"
                    alert.informativeText = "Open \(self.model.dashboardURL.absoluteString) in your browser. Background monitoring continues."
                    alert.runModal()
                }
            }, quit: { NSApp.terminate(nil) }))
            // No account collection here. Read the lightweight status only while the panel is visible.
            timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
                Task { @MainActor in guard let self, self.popover.isShown else { return }; await self.model.update() }
            }
        } catch {
            let alert = NSAlert(); alert.messageText = "QuotaScope needs setup"; alert.informativeText = "The local connection settings could not be read. Reinstall the menu bar app from the QuotaScope project."; alert.runModal(); NSApp.terminate(nil)
        }
    }
    @objc private func togglePanel() {
        if popover.isShown { popover.performClose(nil); return }
        guard let button = item.button else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        NSApp.activate(ignoringOtherApps: true)
        Task { await model.update() }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { togglePanel(); return false }
    func applicationWillTerminate(_ notification: Notification) { timer?.invalidate(); if lockFD >= 0 { close(lockFD) } }
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
