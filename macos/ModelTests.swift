import Foundation

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
        print("Passed native model checks: decoding, percentages, freshness, configuration, CSRF refresh sequence, failures, recovery, single-flight and redirect refusal.")
    }
}
