import Foundation
import Combine

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
