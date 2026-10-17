import Foundation
import CoreGraphics
import AppKit

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
        let clock = Date(timeIntervalSince1970: 1_800_000_000)
        let freshStatus = try decoder.decode(Status.self, from: payload(at: clock.timeIntervalSince1970 * 1000))
        func label(_ status: Status? = freshStatus, window: Allowance? = nil, unavailable: Bool = false, now: Date = clock) -> MenuBarReading {
            MenuBarReading(status: status, window: window ?? status?.windows.first, unavailable: unavailable, now: now)
        }
        precondition(label().title == "73%" && label().detail.contains("Codex · 7 days"))
        precondition(label().accessibilityLabel == "QuotaScope — Codex · 7 days: 73% remaining")
        precondition(label(nil).title == "—" && label(nil).detail == "Connecting to monitor")
        precondition(label(unavailable: true).title == "—")
        precondition(label(now: clock.addingTimeInterval(179)).title == "73%")
        precondition(label(now: clock.addingTimeInterval(180)).title == "—")
        precondition(label(now: clock.addingTimeInterval(-61)).title == "—")
        for (used, expected) in [(0.0,"100%"),(100,"0%"),(99.6,"<1%"),(32,"68%"),(120,"0%"),(-1,"100%"),(Double.nan,"—")] {
            let window = Allowance(account: nil, bucket: "codex", slot: "primary", used: used, duration: 10080, reset: nil, at: clock.timeIntervalSince1970 * 1000)
            precondition(label(window: window).title == expected)
        }
        let expired = Allowance(account: nil, bucket: "codex", slot: "primary", used: 27, duration: 10080, reset: clock.timeIntervalSince1970, at: clock.timeIntervalSince1970 * 1000)
        precondition(label(window: expired).title == "—" && label(window: expired).detail.contains("Reset time reached"))
        let staleWindow = Allowance(account: nil, bucket: "codex", slot: "primary", used: 27, duration: 10080, reset: nil, at: (clock.timeIntervalSince1970 - 180) * 1000)
        precondition(label(window: staleWindow).title == "—") // A fresh attempt cannot freshen an old window.
        let failedStatus = try decoder.decode(Status.self, from: payload(ok: false, at: clock.timeIntervalSince1970 * 1000))
        let pausedStatus = try decoder.decode(Status.self, from: payload(enabled: false, at: clock.timeIntervalSince1970 * 1000))
        precondition(label(failedStatus).title == "—" && label(pausedStatus).detail == "Monitoring paused")
        let emptyStatus = Status(version: 1, csrf: "token", windows: [], collector: freshStatus.collector, attempts: freshStatus.attempts)
        precondition(label(emptyStatus).title == "—")
        for remaining in [0.0, 0.4, 9, 49, 50, 51, 100] {
            let window = Allowance(account: nil, bucket: "codex", slot: "primary", used: 100 - remaining, duration: 10080, reset: nil, at: clock.timeIntervalSince1970 * 1000)
            let reading = label(window: window)
            precondition(abs(reading.remaining! - remaining) < 0.000001)
            let image = MenuBarGauge.image(reading: reading)
            precondition(image.isTemplate && image.size == NSSize(width: 60, height: 22))
        }
        let left = MenuBarGauge.pointer(remaining: 0)!, middle = MenuBarGauge.pointer(remaining: 50)!, right = MenuBarGauge.pointer(remaining: 100)!
        precondition(abs(left.end.x - 2) < 0.001 && abs(left.end.y - 3) < 0.001)
        precondition(abs(middle.end.x - 30) < 0.001 && abs(middle.end.y - 21) < 0.001)
        precondition(abs(right.end.x - 58) < 0.001 && abs(right.end.y - 3) < 0.001)
        var previousX = -Double.infinity
        for percent in 0...100 {
            let needle = MenuBarGauge.pointer(remaining: Double(percent))!
            precondition(needle.end.x >= previousX)
            previousX = needle.end.x
            for p in [needle.start, needle.end] {
                precondition(p.x >= 0.825 && p.x <= 59.175 && p.y >= 0.825 && p.y <= 21.175)
            }
        }
        for reading in [label(nil), label(unavailable: true), label(pausedStatus), label(failedStatus), label(window: expired)] {
            precondition(reading.remaining == nil && MenuBarGauge.pointer(remaining: reading.remaining) == nil)
            precondition(MenuBarGauge.image(reading: reading).isTemplate)
        }
        precondition(MenuBarGauge.pointer(remaining: .nan) == nil)
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
        // A closed panel must keep the number fresh without fetching chart history or refreshing the provider.
        paths = []
        await model.poll(historyVisible: false)
        precondition(paths == ["/api/status"] && model.menuBarReading().title == "73%")
        FixtureProtocol.handler = { request in
            precondition(request.url!.path == "/api/status" && request.httpMethod == "GET")
            return (200, payload(used: 40))
        }
        await model.poll(historyVisible: false)
        precondition(model.menuBarReading().title == "60%")
        let secondary = Allowance(account: nil, bucket: "codex", slot: "secondary", used: 80, duration: 300, reset: nil, at: Date().timeIntervalSince1970 * 1000)
        let multiple = Status(version: 1, csrf: "token", windows: [status.windows[0], secondary], collector: status.collector, attempts: status.attempts)
        precondition(MenuBarReading(status: multiple, window: secondary, unavailable: false, now: Date()).title == "20%")
        FixtureProtocol.handler = { _ in (200,payload()) }
        await model.poll(historyVisible: false)
        FixtureProtocol.handler = { _ in (503,Data()) }
        await model.poll(historyVisible: false); precondition(model.unavailable && model.status?.windows[0].remaining == 73 && !model.busy)
        precondition(model.menuBarReading().title == "—")
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
        precondition(model.menuBarReading().title == "73%")
        let delegate = NoRedirects()
        var redirected = true
        delegate.urlSession(session, task: session.dataTask(with:base), willPerformHTTPRedirection: HTTPURLResponse(url:base,statusCode:302,httpVersion:nil,headerFields:nil)!, newRequest: URLRequest(url:URL(string:"https://example.com")!)) { redirected = $0 != nil }
        precondition(!redirected)
        // The old popover could extend above the display after its content resized.
        for visible in [CGRect(x: 0, y: 0, width: 1920, height: 1050), CGRect(x: -1440, y: 40, width: 1440, height: 860), CGRect(x: 100, y: -900, width: 300, height: 360)] {
            for x in [visible.minX, visible.midX, visible.maxX] {
                let frame = panelFrame(anchor: CGRect(x: x, y: visible.maxY, width: 24, height: 24), visible: visible)
                precondition(visible.contains(frame) && frame.width <= 440 && frame.height <= 560)
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
        let historyPayload = Data("""
        {"version":1,"latest":{"bucket":"codex","slot":"primary","used":27,"at":1},"history":[{"at":1,"used":30}],"localHistory":[],"historyTruncated":false,"localHistoryTruncated":false}
        """.utf8)
        var historyRequests = 0
        FixtureProtocol.handler = { request in
            precondition(request.url!.path == "/api/state")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            precondition(query.first(where: { $0.name == "view" })?.value == "overview")
            precondition(query.first(where: { $0.name == "window" })?.value == "[\"codex\",\"primary\"]")
            historyRequests += 1
            return (200, historyPayload)
        }
        await model.updateHistory(); await model.updateHistory()
        precondition(historyRequests == 1 && model.history?.history.count == 1)
        FixtureProtocol.handler = { _ in (503, Data()) }
        await model.updateHistory(force: true)
        precondition(model.historyUnavailable && model.history?.history.count == 1)
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
            return (200, Data(String(data: historyPayload, encoding: .utf8)!.replacingOccurrences(of: "\"used\":30", with: "\"used\":\(range == "30" ? 30 : 70)").utf8))
        }
        model.days = 30
        let oldRange = Task { await model.updateHistory(force: true) }
        try await Task.sleep(nanoseconds: 10_000_000)
        model.days = 7
        let newRange = Task { await model.updateHistory(force: true) }
        await oldRange.value
        precondition(model.history == nil && model.historyBusy)
        await newRange.value
        precondition(model.history?.history.first?.used == 70 && !model.historyBusy)
        FixtureProtocol.handler = { request in
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            precondition(query.first(where: { $0.name == "historyScope" })?.value == "current")
            precondition(query.first(where: { $0.name == "days" })?.value == "30")
            return (200, Data(String(data: historyPayload, encoding: .utf8)!.dropLast().appending(",\"cycle\":{\"available\":false,\"from\":null,\"reason\":\"Await a fresh reading\"}}").utf8))
        }
        model.days = 0
        await model.updateHistory(force: true)
        precondition(model.history?.cycle?.available == false && model.history?.cycle?.reason == "Await a fresh reading")
        print("Passed history checks: screen bounds, negative display origins, small screens, gap/reset segmentation, remaining percentages, bounded history queries, caching and failure recovery.")
        print("Passed native model checks: decoding, percentages, freshness, configuration, CSRF refresh sequence, failures, recovery, single-flight and redirect refusal.")
        print("Passed menu bar checks: current percentages, zero/full/tiny allowance, stale/paused/missing/expired readings, accessibility, multiple windows and closed-panel polling without history requests.")
    }
}
