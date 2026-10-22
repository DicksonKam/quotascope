import Foundation
import CoreGraphics

// Placement uses AppKit's global, bottom-left coordinates, including negative display origins.
func panelFrame(anchor: CGRect, visible: CGRect, preferred: CGSize = CGSize(width: 440, height: 560)) -> CGRect {
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
struct CycleInfo: Decodable { let available: Bool; let from: Double?; let reason: String }
struct HistoryResponse: Decodable {
    let cycle: CycleInfo?
    let latest: Allowance?
    let version: Int
    let history: [HistoryPoint]
    let localHistory: [HistoryPoint]
    let historyTruncated: Bool
    let localHistoryTruncated: Bool
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

func unitCount(_ value: Int, _ unit: String) -> String { "\(value) \(unit)\(value == 1 ? "" : "s")" }
/// Two largest units, in words, from a reference clock, so the text never jitters or truncates.
func remaining(until date: Date, at now: Date) -> String {
    let seconds = max(0, Int(date.timeIntervalSince(now)))
    let days = seconds / 86400, hours = seconds % 86400 / 3600, minutes = seconds % 3600 / 60
    if days > 0 { return hours > 0 ? "\(unitCount(days, "day")) \(unitCount(hours, "hour"))" : unitCount(days, "day") }
    if hours > 0 { return minutes > 0 ? "\(unitCount(hours, "hour")) \(unitCount(minutes, "minute"))" : unitCount(hours, "hour") }
    return minutes > 0 ? unitCount(minutes, "minute") : "under a minute"
}
func elapsed(since date: Date, at now: Date) -> String {
    let seconds = max(0, Int(now.timeIntervalSince(date)))
    if seconds < 60 { return "\(seconds) sec" }
    if seconds < 3600 { return "\(seconds / 60) min" }
    if seconds < 86400 { return unitCount(seconds / 3600, "hour") }
    return unitCount(seconds / 86400, "day")
}
