// ctv-panel: shows JPEG frames in a small floating panel at the bottom-right
// of the screen. It never activates and never takes keyboard focus. The
// person moves it by dragging and sizes it by dragging an edge; it keeps its
// aspect ratio, and its place and size are remembered between runs.
//
// Usage: ctv-panel [--width 440] [--height 272] [--margin 16]   (points)
// fd 3, the frame stream: each frame is a 4-byte big-endian length, then that
// many bytes of image data (JPEG). Only the newest frame waits for the screen.
// End of fd 3 stops only the frame reader.
// stdin, one command per line:
//   show | hide               order the panel front (no activation) / out
//   resize <factor>           scale the panel (1.25 bigger, 0.8 smaller)
//   snapshot <absolute path>  write a PNG of what the panel shows now
//   drag <ex> <ey> <dx> <dy>  for tests: resize as a drag of those edges would
//                             (ex -1 left, 1 right; ey -1 bottom, 1 top)
// End of stdin or SIGTERM exits 0. stdout stays empty; problems go to stderr.

import AppKit
import ImageIO

func warn(_ message: String) {
  FileHandle.standardError.write(Data("ctv-panel: \(message)\n".utf8))
}

struct Options {
  var width: CGFloat = 440
  var height: CGFloat = 272
  var margin: CGFloat = 16
}

func parseOptions(_ args: [String]) -> Options {
  var options = Options()
  var index = 0
  while index < args.count {
    let name = args[index]
    guard index + 1 < args.count, let value = Double(args[index + 1]), value >= 0 else {
      warn("bad value for \(name)")
      exit(2)
    }
    switch name {
    case "--width": options.width = CGFloat(value)
    case "--height": options.height = CGFloat(value)
    case "--margin": options.margin = CGFloat(value)
    default:
      warn("unknown argument \(name)")
      exit(2)
    }
    index += 2
  }
  if options.width == 0 || options.height == 0 {
    warn("width and height must be above 0")
    exit(2)
  }
  return options
}

enum Command {
  case show
  case hide
  case resize(CGFloat)
  case drag(Int, Int, CGFloat, CGFloat)
  case snapshot(String)
  case end
}

func parseCommand(_ raw: String) -> Command? {
  var line = raw
  if line.hasSuffix("\r") { line.removeLast() }
  if line.isEmpty { return nil }
  let verb: Substring
  let argument: String
  if let space = line.firstIndex(of: " ") {
    verb = line[..<space]
    argument = String(line[line.index(after: space)...])
  } else {
    verb = Substring(line)
    argument = ""
  }
  switch verb {
  case "snapshot" where !argument.isEmpty: return .snapshot(argument)
  case "resize":
    guard let factor = Double(argument), factor > 0 else {
      warn("bad resize factor: \(argument.prefix(40))")
      return nil
    }
    return .resize(CGFloat(factor))
  case "drag":
    let parts = argument.split(separator: " ").compactMap { Double($0) }
    guard parts.count == 4 else {
      warn("bad drag: \(argument.prefix(40))")
      return nil
    }
    return .drag(Int(parts[0]), Int(parts[1]), CGFloat(parts[2]), CGFloat(parts[3]))
  case "show": return .show
  case "hide": return .hide
  default:
    warn("unknown command: \(line.prefix(80))")
    return nil
  }
}

// Commands waiting for the main thread.
final class Inbox: @unchecked Sendable {
  private let lock = NSLock()
  private var commands: [Command] = []
  private var scheduled = false

  // Returns true when the caller must schedule a drain on the main thread.
  func push(_ command: Command) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    commands.append(command)
    if scheduled { return false }
    scheduled = true
    return true
  }

  func take() -> [Command] {
    lock.lock()
    defer { lock.unlock() }
    let taken = commands
    commands = []
    scheduled = false
    return taken
  }
}

// The newest decoded frame waiting for the main thread. A new frame replaces
// one that is still waiting, so frames cannot pile up.
final class FrameSlot: @unchecked Sendable {
  private let lock = NSLock()
  private var image: CGImage?
  private var scheduled = false

  // Returns true when the caller must schedule a drain on the main thread.
  func push(_ newImage: CGImage) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    image = newImage
    if scheduled { return false }
    scheduled = true
    return true
  }

  func take() -> CGImage? {
    lock.lock()
    defer { lock.unlock() }
    let taken = image
    image = nil
    scheduled = false
    return taken
  }
}

// Reads exactly `count` bytes from `fd`, through short reads. Nil at end of
// file or on an error.
func readExact(_ fd: Int32, _ count: Int) -> Data? {
  var data = Data(count: count)
  var done = 0
  while done < count {
    let got = data.withUnsafeMutableBytes { buffer in
      read(fd, buffer.baseAddress! + done, count - done)
    }
    if got > 0 {
      done += got
    } else if got < 0 && errno == EINTR {
      continue
    } else {
      if got < 0 { warn("frame stream: read failed: \(String(cString: strerror(errno)))") }
      return nil
    }
  }
  return data
}

// The frame stream gives no reason to make a frame this large; a larger length
// means the stream is broken.
let maxFrameBytes = 64 << 20

// Decodes the image now, on the calling thread, so the main thread only sets it.
func decodeFrame(_ data: Data) -> CGImage? {
  guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
  let options = [kCGImageSourceShouldCacheImmediately: true] as CFDictionary
  return CGImageSourceCreateImageAtIndex(source, 0, options)
}

final class CornerPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

// Mouse events go to the frame view so a drag anywhere moves the panel.
final class PassThroughImageView: NSImageView {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

// How near an edge, in points, a press must be to size the panel, not move it.
let gripSize: CGFloat = 16

// Which edges of the panel a point is on: x -1 left, 1 right; y -1 bottom, 1 top; 0 neither.
func edges(at point: NSPoint, in bounds: NSRect) -> (x: Int, y: Int) {
  let x = point.x < gripSize ? -1 : (point.x > bounds.width - gripSize ? 1 : 0)
  let y = point.y < gripSize ? -1 : (point.y > bounds.height - gripSize ? 1 : 0)
  return (x, y)
}

// The frame after the given edges were dragged by `delta` (screen points): the
// aspect ratio is kept and the opposite edges stay where they are.
func resizedFrame(
  from start: NSRect, edges: (x: Int, y: Int), delta: NSPoint, minWidth: CGFloat, maxWidth: CGFloat
) -> NSRect {
  let aspect = start.width / start.height
  let byX = start.width + CGFloat(edges.x) * delta.x
  let byY = (start.height + CGFloat(edges.y) * delta.y) * aspect
  var width = start.width
  if edges.x != 0 && edges.y != 0 {
    width = max(byX, byY)
  } else if edges.x != 0 {
    width = byX
  } else if edges.y != 0 {
    width = byY
  }
  width = min(max(width, minWidth), maxWidth)
  let height = width / aspect
  return NSRect(
    x: edges.x == 1 ? start.minX : start.maxX - width,
    y: edges.y == -1 ? start.maxY - height : start.minY,
    width: width, height: height)
}

// The widths the panel may take: half to four times its first size, and never
// more than its screen holds.
@MainActor
func widthLimits(of window: NSWindow) -> (min: CGFloat, max: CGFloat) {
  var most = window.contentMaxSize.width
  if let visible = (window.screen ?? NSScreen.main)?.visibleFrame {
    let aspect = window.contentAspectRatio.width / window.contentAspectRatio.height
    most = min(most, visible.width, visible.height * aspect)
  }
  return (window.contentMinSize.width, most)
}

final class FrameView: NSView {
  let imageView = PassThroughImageView()
  var onResized: (() -> Void)?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.cornerRadius = 10
    layer?.masksToBounds = true
    imageView.frame = bounds
    imageView.autoresizingMask = [.width, .height]
    imageView.imageScaling = .scaleProportionallyUpOrDown
    imageView.imageAlignment = .alignCenter
    imageView.isEditable = false
    addSubview(imageView)
  }

  required init?(coder: NSCoder) { nil }

  override func draw(_ dirtyRect: NSRect) {
    NSColor.black.setFill()
    dirtyRect.fill()
  }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  // A press near an edge or corner sizes the panel; anywhere else moves it.
  override func mouseDown(with event: NSEvent) {
    guard let window else { return }
    let grip = edges(at: convert(event.locationInWindow, from: nil), in: bounds)
    if grip.x == 0 && grip.y == 0 {
      window.performDrag(with: event)
      return
    }
    let start = window.frame
    let origin = NSEvent.mouseLocation
    let limits = widthLimits(of: window)
    while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
      let now = NSEvent.mouseLocation
      window.setFrame(
        resizedFrame(
          from: start, edges: grip, delta: NSPoint(x: now.x - origin.x, y: now.y - origin.y),
          minWidth: limits.min, maxWidth: limits.max),
        display: true)
      if next.type == .leftMouseUp { break }
    }
    window.invalidateShadow()
    onResized?()
  }

  // The pointer shows which way a press here would size the panel.
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(
      NSTrackingArea(
        rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways], owner: self))
  }

  override func mouseMoved(with event: NSEvent) {
    let grip = edges(at: convert(event.locationInWindow, from: nil), in: bounds)
    let position: NSCursor.FrameResizePosition?
    switch (grip.x, grip.y) {
    case (-1, 1): position = .topLeft
    case (1, 1): position = .topRight
    case (-1, -1): position = .bottomLeft
    case (1, -1): position = .bottomRight
    case (-1, 0): position = .left
    case (1, 0): position = .right
    case (0, 1): position = .top
    case (0, -1): position = .bottom
    default: position = nil
    }
    if let position {
      NSCursor.frameResize(position: position, directions: .all).set()
    } else {
      NSCursor.arrow.set()
    }
  }

  override func mouseExited(with event: NSEvent) {
    NSCursor.arrow.set()
  }
}

@MainActor
final class Corner {
  let panel: CornerPanel
  let frameView: FrameView
  // The size the panel starts at; it may shrink to half of it and grow to four times.
  let base: NSSize
  static let savedFrame = "ctv-panel"

  init(options: Options) {
    let size = NSSize(width: options.width, height: options.height)
    base = size
    let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? .zero
    let origin = NSPoint(
      x: visible.maxX - options.margin - size.width,
      y: visible.minY + options.margin)
    panel = CornerPanel(
      contentRect: NSRect(origin: origin, size: size),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false)
    panel.level = .floating
    panel.hidesOnDeactivate = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.isMovableByWindowBackground = true
    panel.isReleasedWhenClosed = false
    frameView = FrameView(frame: NSRect(origin: .zero, size: size))
    panel.contentView = frameView
    panel.contentAspectRatio = size
    panel.contentMinSize = NSSize(width: size.width * 0.5, height: size.height * 0.5)
    panel.contentMaxSize = NSSize(width: size.width * 4, height: size.height * 4)
    // The place and size the person left it at, from an earlier run.
    if panel.setFrameUsingName(Corner.savedFrame) {
      let saved = panel.frame
      let width = min(max(saved.width, size.width * 0.5), size.width * 4)
      panel.setFrame(
        NSRect(x: saved.maxX - width, y: saved.minY, width: width, height: width * size.height / size.width),
        display: false)
    }
    panel.setFrameAutosaveName(Corner.savedFrame)
    frameView.onResized = { [panel] in panel.saveFrame(usingName: Corner.savedFrame) }
  }

  // Scales the panel about its bottom-right corner, inside the limits and the screen.
  private func resize(by factor: CGFloat) {
    let old = panel.frame
    let limits = widthLimits(of: panel)
    let width = min(max(old.width * factor, limits.min), limits.max)
    let height = width * base.height / base.width
    panel.setFrame(NSRect(x: old.maxX - width, y: old.minY, width: width, height: height), display: true)
    panel.invalidateShadow()
    panel.saveFrame(usingName: Corner.savedFrame)
  }

  func apply(_ commands: [Command]) {
    for command in commands {
      autoreleasepool {
        switch command {
        case .show:
          panel.orderFrontRegardless()
          panel.invalidateShadow()
        case .hide: panel.orderOut(nil)
        case .resize(let factor): resize(by: factor)
        case .drag(let ex, let ey, let dx, let dy):
          panel.setFrame(
            resizedFrame(
              from: panel.frame, edges: (ex, ey), delta: NSPoint(x: dx, y: dy),
              minWidth: widthLimits(of: panel).min, maxWidth: widthLimits(of: panel).max),
            display: true)
        case .snapshot(let path): snapshot(path)
        case .end: exit(0)
        }
      }
    }
  }

  func showFrame(_ frame: CGImage) {
    guard frame.width > 0, frame.height > 0 else { return }
    let scale = max(panel.backingScaleFactor, 1)
    let size = NSSize(width: CGFloat(frame.width) / scale, height: CGFloat(frame.height) / scale)
    frameView.imageView.image = NSImage(cgImage: frame, size: size)
  }

  private func snapshot(_ path: String) {
    let bounds = frameView.bounds
    guard let rep = frameView.bitmapImageRepForCachingDisplay(in: bounds) else {
      warn("snapshot: no bitmap")
      return
    }
    frameView.cacheDisplay(in: bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else {
      warn("snapshot: PNG encode failed")
      return
    }
    do {
      try png.write(to: URL(fileURLWithPath: path))
    } catch {
      warn("snapshot: write failed: \(path)")
    }
  }
}

let options = parseOptions(Array(CommandLine.arguments.dropFirst()))
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let corner = MainActor.assumeIsolated { Corner(options: options) }
let inbox = Inbox()
let frameSlot = FrameSlot()

signal(SIGTERM, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler { exit(0) }
termSource.resume()

func enqueue(_ command: Command) {
  guard inbox.push(command) else { return }
  DispatchQueue.main.async {
    MainActor.assumeIsolated { corner.apply(inbox.take()) }
  }
}

let reader = Thread {
  while let line = readLine(strippingNewline: true) {
    if let command = parseCommand(line) { enqueue(command) }
  }
  enqueue(.end)
}
reader.start()

// A frame that does not decode is skipped.
let frameReader = Thread {
  while let header = readExact(3, 4) {
    let length = header.reduce(0) { $0 << 8 | Int($1) }
    guard length <= maxFrameBytes else {
      warn("frame stream: bad length \(length)")
      return
    }
    guard let data = readExact(3, length) else { return }
    guard let frame = decodeFrame(data), frameSlot.push(frame) else { continue }
    DispatchQueue.main.async {
      MainActor.assumeIsolated {
        autoreleasepool {
          if let newest = frameSlot.take() { corner.showFrame(newest) }
        }
      }
    }
  }
}
frameReader.start()
app.run()
