import Foundation
import Combine

struct Allowance: Decodable, Identifiable {
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
    private func request(path: String, token: String? = nil) async throws -> Status {
        var request = URLRequest(url: base.appendingPathComponent(path))
        if let token {
            request.httpMethod = "POST"
            request.httpBody = Data("{}".utf8)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(base.absoluteString, forHTTPHeaderField: "Origin")
            request.setValue(token, forHTTPHeaderField: "X-QuotaScope-Token")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, data.count < 2_000_000 else { throw MonitorError.response }
        let status = try JSONDecoder().decode(Status.self, from: data)
        guard status.version == 1, !status.csrf.isEmpty, Set(status.windows.map(\.id)).count == status.windows.count else { throw MonitorError.incompatible }
        return status
    }
}
@MainActor
final class PanelModel: ObservableObject {
    @Published private(set) var status: Status?
    @Published private(set) var busy = false
    @Published private(set) var unavailable = false
    private let client: MonitorClient
    var dashboardURL: URL { client.base }
    init(client: MonitorClient) { self.client = client }
    func update(refresh: Bool = false) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { status = try await client.read(refresh: refresh); unavailable = false }
        catch { unavailable = true } // Keep the previous reading, explicitly marked stale.
    }
    func headline(at now: Date) -> String {
        if unavailable { return "Monitor unavailable" }
        guard let status else { return "Connecting to monitor…" }
        if !status.collector.enabled { return "Monitoring paused" }
        return status.isFresh(at: now) ? "Monitoring healthy" : "Waiting for a fresh reading"
    }
}
