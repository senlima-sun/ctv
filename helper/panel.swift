// ctv-panel [--width 440] [--height 272] [--margin 16]: a floating, never-focused panel that
// shows JPEG frames or plays an HLS stream; drag to move, drag an edge to size, frame remembered.
// stdin, one per line: show | hide | resize <f> | drag <ex> <ey> <dx> <dy> | snapshot <path> |
// stream <url> | stream-stop | play | pause | toggle | mute on|off | gray on|off; EOF exits 0.
// fd 3: frames as 4-byte big-endian length + JPEG. stdout: {"t":"stream","state":...} lines.

import AVFoundation
import AppKit
import CoreImage
import ImageIO

func warn(_ message: String) {
  FileHandle.standardError.write(Data("ctv-panel: \(message)\n".utf8))
}

func report(_ state: String, message: String? = nil) {
  var line = "{\"t\":\"stream\",\"state\":\"\(state)\""
  if let message,
    let quoted = try? JSONSerialization.data(withJSONObject: message, options: [.fragmentsAllowed])
  {
    line += ",\"message\":" + String(decoding: quoted, as: UTF8.self)
  }
  FileHandle.standardOutput.write(Data((line + "}\n").utf8))
}

struct Options {
  var width: CGFloat = 440
  var height: CGFloat = 272
  var margin: CGFloat = 16
}

func parseOptions(_ args: [String]) -> Options {
  var options = Options()
  for index in stride(from: 0, to: args.count, by: 2) {
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
  case stream(String)
  case streamStop
  case play
  case pause
  case toggle
  case mute(Bool)
  case gray(Bool)
  case end
}

func parseCommand(_ raw: String) -> Command? {
  var line = raw
  if line.hasSuffix("\r") { line.removeLast() }
  if line.isEmpty { return nil }
  let parts = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)
  let argument = parts.count > 1 ? String(parts[1]) : ""
  switch parts[0] {
  case "snapshot" where !argument.isEmpty: return .snapshot(argument)
  case "resize":
    guard let factor = Double(argument), factor > 0 else {
      warn("bad resize factor: \(argument.prefix(40))")
      return nil
    }
    return .resize(CGFloat(factor))
  case "drag":
    let numbers = argument.split(separator: " ").compactMap { Double($0) }
    guard numbers.count == 4 else {
      warn("bad drag: \(argument.prefix(40))")
      return nil
    }
    return .drag(Int(numbers[0]), Int(numbers[1]), CGFloat(numbers[2]), CGFloat(numbers[3]))
  case "stream" where !argument.isEmpty: return .stream(argument)
  case "stream-stop": return .streamStop
  case "play": return .play
  case "pause": return .pause
  case "toggle": return .toggle
  case "mute" where argument == "on" || argument == "off": return .mute(argument == "on")
  case "gray" where argument == "on" || argument == "off": return .gray(argument == "on")
  case "show": return .show
  case "hide": return .hide
  default:
    warn("unknown command: \(line.prefix(80))")
    return nil
  }
}

// Hands a value from a reader thread to the main thread with at most one drain scheduled.
final class Handoff<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private let empty: Value
  private var value: Value
  private var scheduled = false

  init(_ empty: Value) {
    self.empty = empty
    value = empty
  }

  // True when the caller must schedule a drain on the main thread.
  func update(_ change: (inout Value) -> Void) -> Bool {
    lock.withLock {
      change(&value)
      defer { scheduled = true }
      return !scheduled
    }
  }

  func take() -> Value {
    lock.withLock {
      defer { value = empty }
      scheduled = false
      return value
    }
  }
}

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

// A longer frame means the stream is broken.
let maxFrameBytes = 64 << 20

// Decodes on the reader thread so the main thread only sets the image.
func decodeFrame(_ data: Data) -> CGImage? {
  guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
  let options = [kCGImageSourceShouldCacheImmediately: true] as CFDictionary
  return CGImageSourceCreateImageAtIndex(source, 0, options)
}

final class CornerPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

// Mouse events fall through to FrameView, so a drag anywhere moves the panel.
final class PassThroughImageView: NSImageView {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

final class PlayerView: NSView {
  let playerLayer = AVPlayerLayer()

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layerUsesCoreImageFilters = true
    playerLayer.videoGravity = .resizeAspect
    playerLayer.backgroundColor = NSColor.black.cgColor
    playerLayer.cornerRadius = 10
    playerLayer.masksToBounds = true
  }

  required init?(coder: NSCoder) { nil }

  override func makeBackingLayer() -> CALayer { playerLayer }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

let gripSize: CGFloat = 16

// x -1 left, 1 right; y -1 bottom, 1 top; 0 neither.
func edges(at point: NSPoint, in bounds: NSRect) -> (x: Int, y: Int) {
  let x = point.x < gripSize ? -1 : (point.x > bounds.width - gripSize ? 1 : 0)
  let y = point.y < gripSize ? -1 : (point.y > bounds.height - gripSize ? 1 : 0)
  return (x, y)
}

// Keeps the aspect ratio and the opposite edges in place.
func resizedFrame(
  from start: NSRect, edges: (x: Int, y: Int), delta: NSPoint, limits: (min: CGFloat, max: CGFloat)
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
  width = min(max(width, limits.min), limits.max)
  let height = width / aspect
  return NSRect(
    x: edges.x == 1 ? start.minX : start.maxX - width,
    y: edges.y == -1 ? start.maxY - height : start.minY,
    width: width, height: height)
}

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
  let playerView = PlayerView()
  var onResized: (() -> Void)?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.cornerRadius = 10
    layer?.masksToBounds = true
    imageView.imageScaling = .scaleProportionallyUpOrDown
    imageView.imageAlignment = .alignCenter
    imageView.isEditable = false
    playerView.isHidden = true
    for view in [imageView, playerView] {
      view.frame = bounds
      view.autoresizingMask = [.width, .height]
      addSubview(view)
    }
  }

  required init?(coder: NSCoder) { nil }

  override func draw(_ dirtyRect: NSRect) {
    NSColor.black.setFill()
    dirtyRect.fill()
  }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

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
      let delta = NSPoint(x: now.x - origin.x, y: now.y - origin.y)
      window.setFrame(
        resizedFrame(from: start, edges: grip, delta: delta, limits: limits), display: true)
      if next.type == .leftMouseUp { break }
    }
    window.invalidateShadow()
    onResized?()
  }

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
  let base: NSSize
  static let savedFrame = "ctv-panel"
  private var player: AVPlayer?
  private var videoOutput: AVPlayerItemVideoOutput?
  private lazy var imageContext = CIContext()
  private var watchers: [NSKeyValueObservation] = []
  private var notes: [NSObjectProtocol] = []
  private var lastState: String?
  // Playback that pauses while play was asked for has stopped by itself.
  private var wantsPlay = false
  private var muted = false
  private var gray = false

  init(options: Options) {
    let size = NSSize(width: options.width, height: options.height)
    base = size
    let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? .zero
    let origin = NSPoint(
      x: visible.maxX - options.margin - size.width, y: visible.minY + options.margin)
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
    if panel.setFrameUsingName(Corner.savedFrame) {
      // The saved frame may come from other --width/--height values.
      let saved = panel.frame
      let width = min(max(saved.width, size.width * 0.5), size.width * 4)
      let height = width * size.height / size.width
      panel.setFrame(
        NSRect(x: saved.maxX - width, y: saved.minY, width: width, height: height), display: false)
    }
    panel.setFrameAutosaveName(Corner.savedFrame)
    frameView.onResized = { [panel] in panel.saveFrame(usingName: Corner.savedFrame) }
  }

  private func resize(by factor: CGFloat) {
    let old = panel.frame
    let limits = widthLimits(of: panel)
    let width = min(max(old.width * factor, limits.min), limits.max)
    let height = width * base.height / base.width
    panel.setFrame(
      NSRect(x: old.maxX - width, y: old.minY, width: width, height: height), display: true)
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
          let frame = resizedFrame(
            from: panel.frame, edges: (ex, ey), delta: NSPoint(x: dx, y: dy),
            limits: widthLimits(of: panel))
          panel.setFrame(frame, display: true)
        case .snapshot(let path): snapshot(path)
        case .stream(let url): startStream(url)
        case .streamStop: stopStream()
        case .play: control(play: true)
        case .pause: control(play: false)
        case .toggle: control(play: player.map { $0.rate == 0 } ?? false)
        case .mute(let on):
          muted = on
          player?.isMuted = on
        case .gray(let on):
          gray = on
          applyGray()
        case .end: exit(0)
        }
      }
    }
  }

  // Skips a repeated state; nothing follows "failed".
  private func send(_ state: String, message: String? = nil) {
    guard lastState != state, lastState != "failed" else { return }
    lastState = state
    report(state, message: message)
  }

  private func fail(_ message: String) {
    warn("stream: \(message)")
    send("failed", message: message)
  }

  private func startStream(_ text: String) {
    stopStream()
    guard let url = URL(string: text), url.scheme != nil else {
      warn("stream: bad URL: \(text.prefix(80))")
      report("failed", message: "bad URL")
      return
    }
    let item = AVPlayerItem(url: url)
    let videoOutput = AVPlayerItemVideoOutput(pixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
    ])
    item.add(videoOutput)
    self.videoOutput = videoOutput
    let player = AVPlayer(playerItem: item)
    player.isMuted = muted
    self.player = player
    lastState = nil
    wantsPlay = true
    // KVO fires on any thread; hop to main and ignore a stream that was replaced.
    func onMain(_ body: @escaping @MainActor (Corner) -> Void) -> @Sendable () -> Void {
      { [weak self] in
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            guard let self, self.player === player else { return }
            body(self)
          }
        }
      }
    }
    let statusChanged = onMain { corner in
      switch player.timeControlStatus {
      case .playing: corner.send("playing")
      case .paused: corner.send("paused")
      default: break
      }
    }
    let itemChanged = onMain { corner in
      guard item.status == .failed else { return }
      corner.fail(item.error?.localizedDescription ?? "the stream failed")
    }
    watchers = [
      player.observe(\.timeControlStatus, options: [.initial, .new]) { _, _ in statusChanged() },
      item.observe(\.status, options: [.initial, .new]) { _, _ in itemChanged() },
    ]
    let center = NotificationCenter.default
    notes = [
      center.addObserver(
        forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main
      ) { note in
        let error = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
        let message = error?.localizedDescription ?? "the stream stopped"
        MainActor.assumeIsolated {
          guard self.player === player else { return }
          self.fail(message)
        }
      },
      // Error log entries are often transient; fail only if playback stopped against our wish.
      center.addObserver(
        forName: AVPlayerItem.newErrorLogEntryNotification, object: item, queue: .main
      ) { _ in
        MainActor.assumeIsolated {
          guard self.player === player, let event = item.errorLog()?.events.last else { return }
          let message = event.errorComment ?? "error \(event.errorStatusCode)"
          warn("stream: \(event.errorDomain) \(event.errorStatusCode): \(message)")
          if self.wantsPlay && player.timeControlStatus == .paused {
            self.send("failed", message: message)
          }
        }
      },
    ]
    frameView.playerView.playerLayer.player = player
    applyGray()
    frameView.playerView.isHidden = false
    frameView.imageView.isHidden = true
    player.play()
  }

  private func stopStream() {
    guard let player else { return }
    for watcher in watchers { watcher.invalidate() }
    watchers = []
    notes.forEach(NotificationCenter.default.removeObserver)
    notes = []
    player.pause()
    player.replaceCurrentItem(with: nil)
    self.player = nil
    videoOutput = nil
    frameView.playerView.playerLayer.player = nil
    frameView.playerView.isHidden = true
    frameView.imageView.isHidden = false
  }

  private func control(play: Bool) {
    guard let player else {
      report("none")
      return
    }
    wantsPlay = play
    let state = play ? "playing" : "paused"
    // Set before play/pause so the status observer does not send the same state again.
    if lastState != "failed" { lastState = state }
    if play { player.play() } else { player.pause() }
    report(state)
  }

  private func grayFilter() -> CIFilter? {
    guard gray, let filter = CIFilter(name: "CIColorControls") else { return nil }
    filter.setValue(0, forKey: kCIInputSaturationKey)
    return filter
  }

  private func applyGray() {
    frameView.playerView.playerLayer.filters = grayFilter().map { [$0] }
  }

  // Draws the current stream picture fitted on black, as the panel shows it.
  private func streamPicture(in rep: NSBitmapImageRep) {
    guard let player, let videoOutput,
      let buffer = videoOutput.copyPixelBuffer(
        forItemTime: player.currentTime(), itemTimeForDisplay: nil)
    else {
      warn("snapshot: no stream picture yet")
      return
    }
    var image = CIImage(cvPixelBuffer: buffer)
    if let filter = grayFilter() {
      filter.setValue(image, forKey: kCIInputImageKey)
      image = filter.outputImage ?? image
    }
    guard let picture = imageContext.createCGImage(image, from: image.extent),
      let context = NSGraphicsContext(bitmapImageRep: rep)?.cgContext
    else {
      warn("snapshot: stream picture failed")
      return
    }
    // The context draws in points; the bitmap holds them at the screen's scale.
    let bounds = CGRect(origin: .zero, size: rep.size)
    context.setFillColor(NSColor.black.cgColor)
    context.fill(bounds)
    let fit = min(bounds.width / image.extent.width, bounds.height / image.extent.height)
    let size = CGSize(width: image.extent.width * fit, height: image.extent.height * fit)
    context.interpolationQuality = .high
    context.draw(
      picture,
      in: CGRect(
        origin: CGPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2),
        size: size))
    context.flush()
  }

  func showFrame(_ frame: CGImage) {
    guard player == nil, frame.width > 0, frame.height > 0 else { return }
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
    // cacheDisplay cannot capture AVPlayerLayer video, so draw the stream picture directly.
    if let player {
      warn("snapshot: stream time \(player.currentTime().seconds)")
      streamPicture(in: rep)
    } else {
      frameView.cacheDisplay(in: bounds, to: rep)
    }
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
let inbox = Handoff<[Command]>([])
let frameSlot = Handoff<CGImage?>(nil)

signal(SIGTERM, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler { exit(0) }
termSource.resume()

func enqueue(_ command: Command) {
  guard inbox.update({ $0.append(command) }) else { return }
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

// Only the newest frame waits for the main thread; one that does not decode is skipped.
let frameReader = Thread {
  while let header = readExact(3, 4) {
    let length = header.reduce(0) { $0 << 8 | Int($1) }
    guard length <= maxFrameBytes else {
      warn("frame stream: bad length \(length)")
      return
    }
    guard let data = readExact(3, length) else { return }
    guard let frame = decodeFrame(data), frameSlot.update({ $0 = frame }) else { continue }
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
