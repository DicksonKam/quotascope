import AppKit
let folder = CommandLine.arguments[1]
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        let p = CGFloat(pixels)
        NSColor(red: 0.10, green: 0.24, blue: 0.21, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: p * 0.05, y: p * 0.05, width: p * 0.9, height: p * 0.9), xRadius: p * 0.2, yRadius: p * 0.2).fill()
        NSColor(red: 0.66, green: 0.86, blue: 0.75, alpha: 1).setStroke()
        let gauge = NSBezierPath()
        gauge.appendArc(withCenter: NSPoint(x: p * 0.5, y: p * 0.48), radius: p * 0.28, startAngle: -35, endAngle: 215, clockwise: false)
        gauge.move(to: NSPoint(x: p * 0.5, y: p * 0.48)); gauge.line(to: NSPoint(x: p * 0.66, y: p * 0.64))
        gauge.lineWidth = p * 0.045; gauge.lineCapStyle = .round; gauge.stroke()
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: folder).appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
