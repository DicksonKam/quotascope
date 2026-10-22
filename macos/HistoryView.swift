import SwiftUI
import Charts

struct HistoryView: View {
    @ObservedObject var model: PanelModel
    let theme: PanelTheme
    private var accent: Color { theme.accent }
    @ObservedObject var selection: HistorySelection
    private var local: Bool { selection.local }
    private var inspected: PlotPoint? { selection.inspected }
    private var points: [PlotPoint] {
        guard let history = model.history else { return [] }
        if model.days == 0 && history.cycle?.available != true { return [] }
        return allowancePlot(local ? history.localHistory : history.history, local: local)
    }
    private let unit = "% remaining"
    private let plotHeight: CGFloat = 176
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("Allowance history").font(.system(size: 13, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                Spacer()
                Picker("History source", selection: $selection.local) {
                    Text("Account reads").tag(false); Text("Local logs").tag(true)
                }.labelsHidden().controlSize(.small).fixedSize()
                Picker("History range", selection: $model.days) {
                    Text("Current cycle").tag(0); Text("7 days").tag(7); Text("30 days").tag(30); Text("90 days").tag(90)
                }.labelsHidden().controlSize(.small).fixedSize()
            }
            if model.days == 0, let cycle = model.history?.cycle {
                Text(cycle.available ? "Inferred cycle start: \(Date(timeIntervalSince1970: (cycle.from ?? 0) / 1000).formatted(date: .abbreviated, time: .shortened))" : cycle.reason)
                    .font(.system(size: 11)).foregroundStyle(theme.muted)
            }
            Group {
                if points.isEmpty {
                    VStack(spacing: 6) {
                        Image(systemName: "chart.xyaxis.line").font(.system(size: 22)).foregroundStyle(accent)
                        Text(model.historyBusy ? "Loading history…" : model.historyUnavailable ? "History couldn’t be loaded" : "No observations in this range").font(.system(size: 13, weight: .medium))
                        Text("Recorded history appears here as monitoring continues.").font(.system(size: 11)).foregroundStyle(theme.muted)
                    }.frame(maxWidth: .infinity, minHeight: plotHeight)
                } else {
                    historyChart.frame(height: plotHeight)
                }
            }
            // One caption slot: the inspected reading while hovering, otherwise what the line represents.
            if !points.isEmpty {
                if let inspected {
                    Text("\(inspected.date.formatted(date: .abbreviated, time: .shortened)) · \(inspected.value.formatted(.number.precision(.fractionLength(0...1)))) \(unit)")
                        .font(.system(size: 11, weight: .medium)).monospacedDigit()
                } else {
                    Text("\(local ? "Local logs" : "Account reads") · gaps and resets break the line · hover to inspect")
                        .font(.system(size: 11)).foregroundStyle(theme.muted).lineLimit(1)
                }
            }
            if let history = model.history, local ? history.localHistoryTruncated : history.historyTruncated {
                Text("Showing the most recent sampled history in this range.").font(.system(size: 11)).foregroundStyle(theme.muted)
            }
            if model.historyUnavailable {
                HStack(spacing: 8) {
                    Text("History unavailable · saved graph may be out of date").font(.system(size: 11)).foregroundStyle(theme.warning)
                    Spacer()
                    if model.historyBusy {
                        Text("Retrying…").font(.system(size: 11)).foregroundStyle(theme.muted)
                    } else {
                        Button { Task { await model.updateHistory(force: true) } } label: {
                            Text("Retry").font(.system(size: 11, weight: .semibold)).foregroundStyle(accent)
                        }.buttonStyle(.plain).help("Load history again")
                    }
                }
            }
        }
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
        .chartYScale(domain: 0...100)
        .chartXScale(range: .plotDimension(padding: 20))
        .chartYAxis {
            AxisMarks(position: .leading, values: [0, 25, 50, 75, 100]) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.7, dash: [3, 4])).foregroundStyle(theme.line)
                AxisValueLabel { if let number = value.as(Double.self) { Text(number.formatted(.number.precision(.fractionLength(0)))).font(.system(size: 11)).foregroundStyle(theme.muted) } }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { value in
                AxisValueLabel {
                    if let date = value.as(Date.self) {
                        let short = (points.last?.date.timeIntervalSince(points.first?.date ?? .now) ?? 0) < 172800
                        Text(date.formatted(short ? .dateTime.hour().minute() : .dateTime.month(.abbreviated).day())).font(.system(size: 11)).foregroundStyle(theme.muted)
                    }
                }
            }
        }
        .chartYAxisLabel(position: .top, alignment: .leading) {
            Text("% remaining").font(.system(size: 11)).foregroundStyle(theme.muted)
        }
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
        .accessibilityLabel("Remaining allowance history")
    }
}
