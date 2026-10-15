import Foundation
import CoreGraphics

final class FixtureProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (URLRequest) throws -> (Int, Data) = { _ in throw MonitorError.response }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (code, data) = try Self.handler(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
func payload(version: Int = 1, used: Double = 27, ok: Bool = true, enabled: Bool = true, at: Double = Date().timeIntervalSince1970 * 1000) -> Data {
    Data("""
    {"version":\(version),"csrf":"fresh-token","windows":[{"bucket":"codex","slot":"primary","used":\(used),"duration":10080,"reset":2000000000,"at":\(at)}],"collector":{"enabled":\(enabled),"running":false},"attempts":[{"at":\(at),"ok":\(ok)}]}
    """.utf8)
}
@main struct ModelTests {
    @MainActor static func main() async throws {
        let base = try monitorURL(port: 4317)
        for invalid in [0,80,65536,-1] {
            do { _ = try monitorURL(port: invalid); fatalError("Invalid port accepted") } catch {}
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureProtocol.self]
        let session = URLSession(configuration: config)
        let client = MonitorClient(base: base, session: session)
        let decoder = JSONDecoder()
        let status = try decoder.decode(Status.self, from: payload())
        precondition(status.windows[0].remaining == 73 && status.windows[0].title == "Codex · 7 days")
        precondition(status.isFresh())
        let failed = try decoder.decode(Status.self, from: payload(ok: false))
        let old = try decoder.decode(Status.self, from: payload(at: 0))
        let over = try decoder.decode(Status.self, from: payload(used: 120))
        let under = try decoder.decode(Status.self, from: payload(used: -1))
        precondition(!failed.isFresh() && !old.isFresh())
        precondition(over.windows[0].remaining == 0 && under.windows[0].remaining == 100)
        var paths: [String] = []
        FixtureProtocol.handler = { request in
            paths.append(request.url!.path)
            precondition(request.url!.host == "127.0.0.1")
            if request.httpMethod == "POST" {
                precondition(request.value(forHTTPHeaderField: "Origin") == "http://127.0.0.1:4317")
                precondition(request.value(forHTTPHeaderField: "X-QuotaScope-Token") == "fresh-token")
                precondition(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
            } else { precondition(request.value(forHTTPHeaderField: "X-QuotaScope-Token") == nil) }
            return (200,payload())
        }
        _ = try await client.read(refresh: true)
        precondition(paths == ["/api/status","/api/refresh"])
        let model = PanelModel(client: client)
        await model.update(); precondition(model.headline(at: Date()) == "Monitoring healthy")
        FixtureProtocol.handler = { _ in (503,Data()) }
        await model.update(); precondition(model.unavailable && model.status?.windows[0].remaining == 73 && !model.busy)
        FixtureProtocol.handler = { _ in (200,payload(enabled:false)) }
        await model.update(); precondition(!model.unavailable && model.headline(at: Date()) == "Monitoring paused")
        FixtureProtocol.handler = { _ in (200,payload(version:2)) }
        await model.update(); precondition(model.unavailable && model.status?.collector.enabled == false)
        FixtureProtocol.handler = { _ in (200,Data("bad-json".utf8)) }
        await model.update(); precondition(model.unavailable)
        var count = 0
        FixtureProtocol.handler = { _ in count += 1; Thread.sleep(forTimeInterval:0.05); return (200,payload()) }
        async let first: Void = model.update()
        async let second: Void = model.update(refresh:true)
        _ = await (first,second)
        precondition(count == 1 && !model.unavailable && !model.busy)
        let delegate = NoRedirects()
        var redirected = true
        delegate.urlSession(session, task: session.dataTask(with:base), willPerformHTTPRedirection: HTTPURLResponse(url:base,statusCode:302,httpVersion:nil,headerFields:nil)!, newRequest: URLRequest(url:URL(string:"https://example.com")!)) { redirected = $0 != nil }
        precondition(!redirected)
        // The old popover could extend above the display after its content resized.
        for visible in [CGRect(x: 0, y: 0, width: 1920, height: 1050), CGRect(x: -1440, y: 40, width: 1440, height: 860), CGRect(x: 100, y: -900, width: 300, height: 360)] {
            for x in [visible.minX, visible.midX, visible.maxX] {
                let frame = panelFrame(anchor: CGRect(x: x, y: visible.maxY, width: 24, height: 24), visible: visible)
                precondition(visible.contains(frame) && frame.width <= 440 && frame.height <= 600)
                precondition(frame.maxY <= visible.maxY - 8)
            }
        }
        let hp = { (at: Double, used: Double, reset: Double, segment: Int) in
            HistoryPoint(at: at, used: used, reset: reset, account: "one", continuity: "same", chartSegment: segment)
        }
        let historyPoints = [hp(0, 20, 1000, 1), hp(60_000, 30, 1000, 1), hp(240_000, 40, 1000, 1), hp(300_000, 2, 2000, 2)]
        let plotted = allowancePlot(historyPoints, local: false)
        precondition(plotted.map(\.value) == [80,70,60,98])
        precondition(plotted.map(\.segment) == [0,0,0,1]) // Server segments survive downsampling.
        let unsampled = historyPoints.map { HistoryPoint(at: $0.at, used: $0.used, reset: $0.reset, account: $0.account, continuity: $0.continuity, chartSegment: nil) }
        precondition(allowancePlot(unsampled, local: false).map(\.segment) == [0,0,1,2])
        precondition(allowancePlot(historyPoints, local: true).map(\.segment) == [0,0,0,1])
        let date = ISO8601DateFormatter().date(from: "2026-03-09T16:00:00Z")!
        let days = [ActivityDay(name: "2026-03-07", total: 100), ActivityDay(name: "2026-03-08", total: 200), ActivityDay(name: "2026-03-09", total: 300), ActivityDay(name: "bad", total: 9), ActivityDay(name: "2026-03-11", total: 5)]
        let daily = activityPlot(days, count: 3, now: date, timezone: TimeZone(identifier: "America/New_York")!)
        precondition(daily.count == 3 && daily.map(\.segment) == [0,0,0]) // DST day isn't a gap.
        precondition(activityPlot([days[0], days[2]], count: 3, now: date, timezone: TimeZone(identifier: "America/New_York")!).map(\.segment) == [0,1])
        let historyPayload = Data("""
        {"version":1,"latest":{"bucket":"codex","slot":"primary","used":27,"at":1},"history":[],"localHistory":[],"historyTruncated":false,"localHistoryTruncated":false,"usage":{"days":[{"name":"2026-03-09","total":300}],"recentTokensPerMinute":5}}
        """.utf8)
        var historyRequests = 0
        FixtureProtocol.handler = { request in
            precondition(request.url!.path == "/api/state")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            precondition(query.first(where: { $0.name == "view" })?.value == "activity")
            precondition(query.first(where: { $0.name == "window" })?.value == "[\"codex\",\"primary\"]")
            historyRequests += 1
            return (200, historyPayload)
        }
        await model.updateHistory(); await model.updateHistory()
        precondition(historyRequests == 1 && model.history?.usage.days.count == 1)
        FixtureProtocol.handler = { _ in (503, Data()) }
        await model.updateHistory(force: true)
        precondition(model.historyUnavailable && model.history?.usage.days.count == 1)
        model.days = 7
        await model.updateHistory(force: true)
        precondition(model.historyUnavailable && model.history == nil && !model.historyBusy)
        FixtureProtocol.handler = { _ in (200, historyPayload) }
        await model.updateHistory(force: true)
        precondition(!model.historyUnavailable && model.history != nil)
        FixtureProtocol.handler = { _ in (200, Data(String(data: historyPayload, encoding: .utf8)!.replacingOccurrences(of: "\"version\":1", with: "\"version\":2").utf8)) }
        await model.updateHistory(force: true)
        precondition(model.historyUnavailable && model.history != nil)
        FixtureProtocol.handler = { _ in (200, Data(String(data: historyPayload, encoding: .utf8)!.replacingOccurrences(of: "\"slot\":\"primary\"", with: "\"slot\":\"secondary\"").utf8)) }
        await model.updateHistory(force: true)
        precondition(model.historyUnavailable) // Never relabel a different allowance window.
        // A slow old range must not overwrite a newer selection.
        FixtureProtocol.handler = { request in
            let range = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first(where: { $0.name == "days" })!.value!
            Thread.sleep(forTimeInterval: range == "30" ? 0.05 : 0.1)
            return (200, Data(String(data: historyPayload, encoding: .utf8)!.replacingOccurrences(of: "\"total\":300", with: "\"total\":\(range == "30" ? 300 : 700)").utf8))
        }
        model.days = 30
        let oldRange = Task { await model.updateHistory(force: true) }
        try await Task.sleep(nanoseconds: 10_000_000)
        model.days = 7
        let newRange = Task { await model.updateHistory(force: true) }
        await oldRange.value
        precondition(model.history == nil && model.historyBusy)
        await newRange.value
        precondition(model.history?.usage.days.first?.total == 700 && !model.historyBusy)
        print("Passed history checks: screen bounds, negative display origins, small screens, gap/reset segmentation, remaining percentages, calendar/DST ranges, bounded history queries, caching and failure recovery.")
        print("Passed native model checks: decoding, percentages, freshness, configuration, CSRF refresh sequence, failures, recovery, single-flight and redirect refusal.")
    }
}
