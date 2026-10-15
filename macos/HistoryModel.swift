import Foundation
import CoreGraphics

// Placement uses AppKit's global, bottom-left coordinates, including negative display origins.
func panelFrame(anchor: CGRect, visible: CGRect, preferred: CGSize = CGSize(width: 440, height: 600)) -> CGRect {
    let inset = min(8, min(visible.width, visible.height) / 4)
    let safe = visible.insetBy(dx: inset, dy: inset)
    let size = CGSize(width: min(preferred.width, safe.width), height: min(preferred.height, safe.height))
    let x = min(max(anchor.midX - size.width / 2, safe.minX), safe.maxX - size.width)
    let y = min(max(anchor.minY - 6 - size.height, safe.minY), safe.maxY - size.height)
    return CGRect(origin: CGPoint(x: x, y: y), size: size)
}
struct HistoryPoint: Decodable {
    let at: Double
    let used: Double
    let reset: Double?
    let account: String?
    let continuity: String?
    let chartSegment: Int?
    var remaining: Double { min(100, max(0, 100 - used)) }
}
struct ActivityDay: Decodable { let name: String; let total: Double }
struct ActivityUsage: Decodable { let days: [ActivityDay]; let recentTokensPerMinute: Double }
struct HistoryResponse: Decodable {
    let latest: Allowance?
    let version: Int
    let history: [HistoryPoint]
    let localHistory: [HistoryPoint]
    let historyTruncated: Bool
    let localHistoryTruncated: Bool
    let usage: ActivityUsage
}
struct PlotPoint: Identifiable {
    let id: Int
    let date: Date
    let value: Double
    let segment: Int
}
func allowancePlot(_ points: [HistoryPoint], local: Bool) -> [PlotPoint] {
    var segment = 0
    return points.enumerated().map { index, point in
        if index > 0 {
            let previous = points[index - 1]
            let changedReset = previous.reset != nil && point.reset != nil && abs(point.reset! - previous.reset!) > 60
            if previous.account != point.account || previous.continuity != point.continuity || previous.chartSegment != point.chartSegment || changedReset || point.used < previous.used || ((previous.chartSegment == nil || point.chartSegment == nil) && point.at - previous.at > (local ? 21_600_000 : 120_000)) {
                segment += 1
            }
        }
        return PlotPoint(id: index, date: Date(timeIntervalSince1970: point.at / 1000), value: point.remaining, segment: segment)
    }
}
func activityPlot(_ days: [ActivityDay], count: Int, now: Date = Date(), timezone: TimeZone = .current) -> [PlotPoint] {
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = timezone
    let start = calendar.date(byAdding: .day, value: -(count - 1), to: calendar.startOfDay(for: now))!
    let end = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now))!
    let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = calendar; formatter.timeZone = timezone; formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
    let dated = days.compactMap { day -> (Date, Double)? in
        guard let date = formatter.date(from: day.name), formatter.string(from: date) == day.name, date >= start, date < end, day.total >= 0 else { return nil }
        return (date, day.total)
    }.sorted { $0.0 < $1.0 }
    var segment = 0
    return dated.enumerated().map { index, pair in
        if index > 0, calendar.dateComponents([.day], from: dated[index - 1].0, to: pair.0).day != 1 { segment += 1 }
        return PlotPoint(id: index, date: pair.0, value: pair.1, segment: segment)
    }
}
