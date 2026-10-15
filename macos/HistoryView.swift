import SwiftUI
import Charts

func compactNumber(_ value: Double) -> String {
    let scale: (Double, String) = value >= 1_000_000_000 ? (1_000_000_000, "B") : value >= 1_000_000 ? (1_000_000, "M") : value >= 1_000 ? (1_000, "K") : (1, "")
    return (value / scale.0).formatted(.number.precision(.fractionLength(0...1))) + scale.1
}
struct HistoryView: View {
    @ObservedObject var model: PanelModel
    let accent: Color
    @ObservedObject var selection: HistorySelection
    private var mode: String { selection.mode }
    private var local: Bool { selection.local }
    private var inspected: PlotPoint? { selection.inspected }
    private var points: [PlotPoint] {
        guard let history = model.history else { return [] }
        return mode == "Activity" ? activityPlot(history.usage.days, count: model.days) : allowancePlot(local ? history.localHistory : history.history, local: local)
    }
    private var unit: String { mode == "Activity" ? "tokens" : "% remaining" }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 4) {
                ForEach(["Activity", "Allowance"], id: \.self) { title in
                    Button { selection.mode = title } label: {
                        Text(title).font(.system(size: 12, weight: .medium))
                            .frame(maxWidth: .infinity).padding(.vertical, 7)
                            .background(mode == title ? accent.opacity(0.20) : Color.clear, in: RoundedRectangle(cornerRadius: 7))
                            .foregroundStyle(mode == title ? accent : .secondary)
                    }.buttonStyle(.plain).accessibilityAddTraits(mode == title ? .isSelected : [])
                }
            }.padding(3).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 9))
            HStack {
                Text(mode == "Activity" ? "Daily token activity" : "Allowance over time").font(.system(size: 15, weight: .semibold))
                Spacer()
                Picker("History range", selection: $model.days) {
                    Text("7 days").tag(7); Text("30 days").tag(30); Text("90 days").tag(90)
                }.labelsHidden().fixedSize()
            }
            if mode == "Allowance" {
                HStack {
                    if (model.status?.windows.count ?? 0) > 1 {
                        Picker("Allowance window", selection: Binding(get: { model.window?.id ?? "" }, set: { model.selectedWindow = $0 })) {
                            ForEach(model.status?.windows ?? []) { Text($0.title).tag($0.id) }
                        }.labelsHidden()
                    } else { Text(model.window?.title ?? "Allowance").font(.system(size: 11)).foregroundStyle(.secondary) }
                    Spacer()
                    Picker("History source", selection: $selection.local) {
                        Text("Account reads").tag(false); Text("Local logs").tag(true)
                    }.labelsHidden().fixedSize()
                }
            }
            Group {
                if points.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "chart.xyaxis.line").font(.system(size: 26)).foregroundStyle(accent)
                        Text(model.historyBusy ? "Loading history…" : model.historyUnavailable ? "History couldn’t be loaded" : "No observations in this range").font(.system(size: 13, weight: .medium))
                        Text("Recorded history appears here as monitoring continues.").font(.system(size: 11)).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, minHeight: 190)
                } else {
                    historyChart.frame(height: 190)
                }
            }
            VStack(alignment: .leading, spacing: 5) {
                if let inspected {
                    Text("\(inspected.date.formatted(date: .abbreviated, time: mode == "Activity" ? .omitted : .shortened)) · \(compactNumber(inspected.value)) \(unit)").font(.system(size: 11, weight: .medium)).monospacedDigit()
                } else {
                    Text("Move over the graph to inspect a recorded value.").font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Text(mode == "Activity" ? "Local logs · all observed accounts · \(TimeZone.current.identifier)" : "\(local ? "Local logs" : "Account reads") · gaps and resets break the line")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                if mode == "Activity" { Text("Missing log activity is not included; today is partial.").font(.system(size: 10)).foregroundStyle(.secondary) }
                if mode == "Allowance", let history = model.history, local ? history.localHistoryTruncated : history.historyTruncated {
                    Text("Showing the most recent sampled history in this range.").font(.system(size: 10)).foregroundStyle(.secondary)
                }
                if model.historyUnavailable {
                    Text("History unavailable · saved graph may be out of date").font(.system(size: 11)).foregroundStyle(.orange)
                    Button("Retry history") { Task { await model.updateHistory(force: true) } }.disabled(model.historyBusy)
                }
            }.frame(minHeight: 46, alignment: .topLeading)
        }
        .onChange(of: mode) { _ in selection.inspected = nil }
        .onChange(of: local) { _ in selection.inspected = nil }
        .onChange(of: model.days) { _ in selection.inspected = nil; Task { await model.updateHistory(force: true) } }
        .onChange(of: model.selectedWindow) { _ in selection.inspected = nil; Task { await model.updateHistory(force: true) } }
        .onChange(of: model.historyBusy) { _ in selection.inspected = nil }
    }
    private var historyChart: some View {
        Chart(points) { point in
            LineMark(x: .value("Date", point.date), y: .value(unit, point.value), series: .value("Continuity", point.segment))
                .foregroundStyle(accent).lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
            PointMark(x: .value("Date", point.date), y: .value(unit, point.value))
                .foregroundStyle(accent).symbolSize(points.count < 100 ? 12 : 3)
            if let inspected, inspected.id == point.id {
                RuleMark(x: .value("Date", point.date)).foregroundStyle(accent.opacity(0.4))
                PointMark(x: .value("Date", point.date), y: .value(unit, point.value)).foregroundStyle(accent).symbolSize(42)
            }
        }
        .chartYScale(domain: 0...(mode == "Activity" ? max(1, (points.map(\.value).max() ?? 1) * 1.08) : 100))
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                AxisGridLine().foregroundStyle(Color.secondary.opacity(0.15))
                AxisValueLabel { if let number = value.as(Double.self) { Text(compactNumber(number)).font(.system(size: 10)) } }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { value in
                AxisValueLabel {
                    if let date = value.as(Date.self) {
                        let short = mode == "Allowance" && (points.last?.date.timeIntervalSince(points.first?.date ?? .now) ?? 0) < 172800
                        Text(date.formatted(short ? .dateTime.hour().minute() : .dateTime.month(.abbreviated).day())).font(.system(size: 10))
                    }
                }
            }
        }
        .chartYAxisLabel(mode == "Activity" ? "Tokens / day" : "% remaining", position: .top, alignment: .leading)
        .chartOverlay { proxy in
            GeometryReader { geometry in
                let inspect: (CGPoint) -> Void = { location in
                    let frame = geometry[proxy.plotAreaFrame]
                    guard frame.contains(location), let date: Date = proxy.value(atX: location.x - frame.minX) else { selection.inspected = nil; return }
                    // Report a recorded point with its own timestamp, never an interpolated value.
                    selection.inspected = points.min { abs($0.date.timeIntervalSince(date)) < abs($1.date.timeIntervalSince(date)) }
                }
                Rectangle().fill(.clear).contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let location): inspect(location)
                        case .ended: selection.inspected = nil
                        }
                    }
                    .gesture(DragGesture(minimumDistance: 0).onChanged { inspect($0.location) })
            }
        }
        .accessibilityLabel(mode == "Activity" ? "Daily observed token history" : "Remaining allowance history")
    }
}
