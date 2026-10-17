import Foundation
import Combine
import AppKit

struct Allowance: Decodable, Identifiable {
    let account: String?
    let bucket: String
    let slot: String
    let used: Double
    let duration: Double?
    let reset: Double?
    let at: Double
    var id: String { "\(bucket)/\(slot)" }
    var remaining: Double { min(100, max(0, 100 - used)) }
    var title: String {
        let name = bucket == "codex" ? "Codex" : bucket
        guard let minutes = duration, minutes > 0 else { return "\(name) · \(slot)" }
        if minutes >= 1440 { return "\(name) · \(Int(minutes / 1440)) days" }
        if minutes >= 60 { return "\(name) · \(Int(minutes / 60)) hours" }
        return "\(name) · \(Int(minutes)) minutes"
    }
}
struct ReadAttempt: Decodable { let at: Double; let ok: Bool }
struct MonitorState: Decodable { let enabled: Bool; let running: Bool }
struct Status: Decodable {
    let version: Int
    let csrf: String
    let windows: [Allowance]
    let collector: MonitorState
    let attempts: [ReadAttempt]
    var latestRead: Date? { attempts.first.map { Date(timeIntervalSince1970: $0.at / 1000) } }
    func isFresh(at now: Date = Date()) -> Bool {
        guard let read = latestRead, attempts.first?.ok == true else { return false }
        let age = now.timeIntervalSince(read)
        return age >= -60 && age < 180
    }
}
struct ConnectionSettings: Decodable { let port: Int? }
struct AppConnection: Decodable { let settingsPath: String; let port: Int }
func monitorURL(port: Int) throws -> URL {
    guard (1024...65535).contains(port), let url = URL(string: "http://127.0.0.1:\(port)") else {
        throw MonitorError.configuration
    }
    return url
}
enum MonitorError: Error { case configuration, response, incompatible }

struct MenuBarReading: Equatable {
    let title: String
    let remaining: Double?
    let detail: String
    var accessibilityLabel: String { "QuotaScope — \(detail)" }

    init(status: Status?, window: Allowance?, unavailable: Bool, now: Date) {
        var reason: String?
        if unavailable { reason = "Monitor unavailable" }
        else if status == nil { reason = "Connecting to monitor" }
        else if status?.collector.enabled == false { reason = "Monitoring paused" }
        else if window == nil { reason = "No allowance available" }
        else if status?.isFresh(at: now) != true { reason = "Waiting for a fresh reading" }
        else if let window {
            let age = now.timeIntervalSince1970 - window.at / 1000
            if !window.used.isFinite || !age.isFinite || age < -60 || age >= 180 {
                reason = "Waiting for a fresh reading"
            } else if let reset = window.reset, !reset.isFinite || reset <= now.timeIntervalSince1970 {
                reason = "Reset time reached · awaiting a reading"
            }
        }
        if let reason {
            title = "—"
            remaining = nil
            detail = reason
        } else if let window {
            // Match the panel's rounding; preserve a small nonzero allowance without displaying 0%.
            let value = window.remaining
            remaining = value
            title = value > 0 && value < 1 ? "<1%" : "\(Int(value.rounded()))%"
            detail = "\(window.title): \(title) remaining"
        } else {
            title = "—"
            remaining = nil
            detail = "No allowance available"
        }
    }
}

enum MenuBarGauge {
    static let size = NSSize(width: 60, height: 22)
    static func pointer(remaining: Double?) -> (start: NSPoint, end: NSPoint)? {
        guard let remaining, remaining.isFinite else { return nil }
        let angle = Double.pi * (1 - min(100, max(0, remaining)) / 100)
        let x = 30 + 22 * cos(angle), y = 3 + 12 * sin(angle)
        // Follow the ellipse's outward normal so the pointer never enters the numerals.
        let nx = cos(angle) / 22, ny = sin(angle) / 12
        let length = hypot(nx, ny)
        return (NSPoint(x: x + 2 * nx / length, y: y + 2 * ny / length),
                NSPoint(x: x + 6 * nx / length, y: y + 6 * ny / length))
    }
    static func image(reading: MenuBarReading) -> NSImage {
        let text = NSMutableAttributedString(string: reading.title, attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular),
            .foregroundColor: NSColor.black,
        ])
        if reading.title.hasSuffix("%") {
            text.addAttribute(.font, value: NSFont.systemFont(ofSize: 8, weight: .regular), range: NSRange(location: (reading.title as NSString).length - 1, length: 1))
        }
        let pointer = pointer(remaining: reading.remaining)
        // Render at native resolution; macOS supplies contrast and selection colors.
        let image = NSImage(size: size, flipped: false) { _ in
            let arc = NSBezierPath()
            arc.move(to: NSPoint(x: 8, y: 3))
            arc.curve(to: NSPoint(x: 30, y: 15), controlPoint1: NSPoint(x: 8, y: 9.6274), controlPoint2: NSPoint(x: 17.8497, y: 15))
            arc.curve(to: NSPoint(x: 52, y: 3), controlPoint1: NSPoint(x: 42.1503, y: 15), controlPoint2: NSPoint(x: 52, y: 9.6274))
            arc.lineWidth = 1.05; arc.lineCapStyle = .round
            NSColor.black.withAlphaComponent(pointer == nil ? 0.28 : 0.46).setStroke()
            arc.stroke()
            if let pointer {
                let needle = NSBezierPath()
                needle.move(to: pointer.start); needle.line(to: pointer.end)
                needle.lineWidth = 1.65; needle.lineCapStyle = .round
                NSColor.black.setStroke(); needle.stroke()
            }
            text.draw(at: NSPoint(x: (size.width - text.size().width) / 2, y: 0))
            return true
        }
        image.isTemplate = true
        return image
    }
}

// Never follow a localhost redirect with the in-memory request token.
final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
final class MonitorClient {
    let base: URL
    let session: URLSession
    init(base: URL, session: URLSession? = nil) {
        self.base = base
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 20
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = session ?? URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }
    func read(refresh: Bool = false) async throws -> Status {
        // Obtain a current token first: the monitor may have restarted since the panel last opened.
        let current = try await request(path: "/api/status")
        return refresh ? try await request(path: "/api/refresh", token: current.csrf) : current
    }
    func history(days: Int, window: Allowance?) async throws -> HistoryResponse {
        var url = URLComponents(url: base.appendingPathComponent("/api/state"), resolvingAgainstBaseURL: false)!
        let key = try window.map { String(data: try JSONEncoder().encode([$0.bucket, $0.slot]), encoding: .utf8)! } ?? ""
        url.queryItems = [URLQueryItem(name: "view", value: "overview"), URLQueryItem(name: "days", value: String(days == 0 ? 30 : days)), URLQueryItem(name: "historyScope", value: days == 0 ? "current" : "range"), URLQueryItem(name: "window", value: key), URLQueryItem(name: "timezone", value: TimeZone.current.identifier)]
        let result: HistoryResponse = try await decodedRequest(url: url.url!)
        guard result.version == 1, result.history.count <= 600, result.localHistory.count <= 600 else { throw MonitorError.incompatible }
        if days == 0 && result.cycle == nil { throw MonitorError.incompatible }
        if let window {
            guard result.latest?.id == window.id, result.latest?.account == window.account else { throw MonitorError.incompatible }
        }
        return result
    }
    private func request(path: String, token: String? = nil) async throws -> Status {
        let status: Status = try await decodedRequest(url: base.appendingPathComponent(path), token: token)
        guard status.version == 1, !status.csrf.isEmpty, Set(status.windows.map(\.id)).count == status.windows.count else { throw MonitorError.incompatible }
        return status
    }
    private func decodedRequest<T: Decodable>(url: URL, token: String? = nil) async throws -> T {
        var request = URLRequest(url: url)
        if let token {
            request.httpMethod = "POST"
            request.httpBody = Data("{}".utf8)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(base.absoluteString, forHTTPHeaderField: "Origin")
            request.setValue(token, forHTTPHeaderField: "X-QuotaScope-Token")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, data.count < 2_000_000 else { throw MonitorError.response }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
final class HistorySelection: ObservableObject {
    @Published var local = false
    @Published var inspected: PlotPoint?
}
@MainActor
final class PanelModel: ObservableObject {
    @Published private(set) var status: Status?
    @Published private(set) var busy = false
    @Published private(set) var unavailable = false
    @Published private(set) var history: HistoryResponse?
    @Published private(set) var historyBusy = false
    @Published private(set) var historyUnavailable = false
    let historySelection = HistorySelection()
    @Published var days = 30
    @Published var selectedWindow = ""
    private var historyKey = ""
    private var historyGeneration = 0
    private var historyReadAt: Date?
    var window: Allowance? { status?.windows.first(where: { $0.id == selectedWindow }) ?? status?.windows.first }
    private let client: MonitorClient
    var dashboardURL: URL { client.base }
    init(client: MonitorClient) { self.client = client }
    func menuBarReading(at now: Date = Date()) -> MenuBarReading {
        MenuBarReading(status: status, window: window, unavailable: unavailable, now: now)
    }
    func poll(historyVisible: Bool) async {
        await update()
        if historyVisible { await updateHistory() }
    }
    func update(refresh: Bool = false) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let next = try await client.read(refresh: refresh)
            if next.windows.first?.account != status?.windows.first?.account {
                history = nil; historyReadAt = nil; historyGeneration += 1; historyBusy = false
            }
            status = next; unavailable = false
        }
        catch { unavailable = true } // Keep the previous reading, explicitly marked stale.
    }
    func updateHistory(force: Bool = false) async {
        let selected = window
        let key = "\(days)/\(selected?.account ?? "")/\(selected?.id ?? "")/\(TimeZone.current.identifier)"
        if !force && key == historyKey && (historyBusy || (historyReadAt.map { Date().timeIntervalSince($0) < 60 } ?? false)) { return }
        if key != historyKey { history = nil }
        historyKey = key; historyGeneration += 1
        let generation = historyGeneration
        historyBusy = true
        do {
            let result = try await client.history(days: days, window: selected)
            guard generation == historyGeneration else { return }
            history = result; historyUnavailable = false; historyReadAt = Date()
        } catch {
            guard generation == historyGeneration else { return }
            historyUnavailable = true
        }
        historyBusy = false
    }
    func headline(at now: Date) -> String {
        if unavailable { return "Monitor unavailable" }
        guard let status else { return "Connecting to monitor…" }
        if !status.collector.enabled { return "Monitoring paused" }
        return status.isFresh(at: now) ? "Monitoring healthy" : "Waiting for a fresh reading"
    }
}
