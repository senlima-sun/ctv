#!/usr/bin/env node
// view: run a headless Chrome that shows YouTube and send the page picture
// as JPEG frames to the floating panel over a pipe (its fd 3). A YouTube live
// video plays in the panel itself instead (its AVPlayer, from the video's HLS
// URL): the page then goes to about:blank and no frames are sent, which costs
// much less CPU. Zero npm dependencies (Node 22).
//
// stdout: one JSON object per line (ready / nav / error).
// stderr: diagnostics.
// control: HTTP server on <run-dir>/control.sock.

import { spawn, execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

const CHROME_APP = "/Applications/Google Chrome.app";
const CHROME_BIN = `${CHROME_APP}/Contents/MacOS/Google Chrome`;
const LOGIN_URL = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F";
const MAX_FPS = 24;
const CDP_TIMEOUT_MS = 10000;
// A playing video that sends no frame for this long means Chrome stopped the
// screencast (it waits for acks): the watchdog starts it again.
const FRAME_STALL_MS = 3000;
// How long POST /navigate waits for a YouTube video's player data to tell
// whether it is live.
const LIVE_CHECK_MS = 10000;
// How long POST /toggle waits for the panel's answer while a stream plays.
const PANEL_ANSWER_MS = 3000;
// The floating panel that shows the frames: a small Swift program, built once
// from the source beside this file. The binary lives outside the mod folder so
// writing it does not reload the mod.
const PANEL_SRC = path.join(import.meta.dirname, "panel.swift");
const DATA_DIR = path.join(os.homedir(), "Library/Application Support/ctv");
const PANEL_BIN = path.join(DATA_DIR, "ctv-panel");
const SUN_PATH_MAX = 103;

// The mod was named yt-corner before: move its data dir once, so the Chrome
// profile and its Google sign-in stay. The old panel binary is built again
// under its new name.
const OLD_DATA_DIR = path.join(os.homedir(), "Library/Application Support/yt-corner");
if (!fs.existsSync(DATA_DIR) && fs.existsSync(OLD_DATA_DIR)) {
  fs.renameSync(OLD_DATA_DIR, DATA_DIR);
  fs.rmSync(path.join(DATA_DIR, "yt-panel"), { force: true });
}

// ---------- args ----------

const { values: args } = parseArgs({
  options: {
    "run-dir": { type: "string" },
    profile: { type: "string", default: path.join(DATA_DIR, "chrome-profile") },
    width: { type: "string", default: "440" },
    height: { type: "string", default: "272" },
    scale: { type: "string", default: "2" },
    url: { type: "string", default: "about:blank" },
    mute: { type: "boolean", default: false },
    "no-panel": { type: "boolean", default: false },
    gray: { type: "boolean", default: false },
    login: { type: "boolean", default: false },
  },
});

// --login: open a normal, visible Chrome window on the helper's profile so the
// person signs in to Google once. No debugging flags: Google refuses sign-in
// in an automated browser.
if (args.login) {
  fs.mkdirSync(path.resolve(args.profile), { recursive: true });
  execFileSync("/usr/bin/open", [
    "-na", CHROME_APP, "--args",
    `--user-data-dir=${path.resolve(args.profile)}`,
    "--no-first-run", "--no-default-browser-check", LOGIN_URL,
  ]);
  process.exit(0);
}

if (!args["run-dir"]) {
  emit({ t: "error", message: "--run-dir is required" });
  process.exit(2);
}

const runDir = path.resolve(args["run-dir"]);
const profileDir = path.resolve(args.profile);
const width = Number(args.width);
const height = Number(args.height);
const scale = Number(args.scale);
const sockPath = path.join(runDir, "control.sock");

// ---------- output ----------

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function log(...parts) {
  process.stderr.write(`[ctv-view] ${parts.join(" ")}\n`);
}

// ---------- CDP client ----------

// Chrome runs with --remote-debugging-pipe: it reads commands from fd 3 and
// writes replies and events to fd 4. Each message is one JSON text and a NUL.
class Cdp {
  constructor(output, input) {
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    // Bytes after the last NUL: kept as Buffers and decoded at the next NUL, so
    // a UTF-8 character split between two reads stays whole.
    this.chunks = [];
    this.output = output;
    this.input = input;
    this.output.on("error", () => this.onEnd());
    this.input.on("data", (chunk) => this.onData(chunk));
    this.input.on("end", () => this.onEnd());
    this.input.on("close", () => this.onEnd());
    this.input.on("error", () => this.onEnd());
  }

  onData(chunk) {
    let start = 0;
    for (let nul = chunk.indexOf(0); nul !== -1; nul = chunk.indexOf(0, start)) {
      this.chunks.push(chunk.subarray(start, nul));
      const text = Buffer.concat(this.chunks).toString("utf8");
      this.chunks = [];
      start = nul + 1;
      this.onMessage(text);
    }
    if (start < chunk.length) this.chunks.push(chunk.subarray(start));
  }

  onEnd() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("CDP connection closed"));
    }
    this.pending.clear();
    this.onClose?.();
  }

  onMessage(text) {
    const msg = JSON.parse(text);
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    for (const fn of this.handlers.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
  }

  send(method, params = {}, sessionId, timeoutMs = CDP_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      this.output.write(`${JSON.stringify(msg)}\0`);
    });
  }

  // Several handlers may listen to one method. Returns a function that removes
  // this handler only.
  on(method, fn) {
    let fns = this.handlers.get(method);
    if (!fns) this.handlers.set(method, (fns = new Set()));
    fns.add(fn);
    return () => fns.delete(fn);
  }

  close() {
    this.output.destroy();
    this.input.destroy();
  }
}

// ---------- state ----------

let chrome = null;
let cdp = null;
let session = null;
let targetId = null;
let server = null;
let casting = false;
let panel = null;
let gray = false;
let muted = false;
let mutedScript = null;
let lastFrameAt = 0;
let lastRawFrameAt = 0;
// The panel's frame pipe is full: drop frames until it drains.
let panelBusy = false;
let watchdog = null;
let watchdogBusy = false;
let pointerDown = false;
let lastUrl = "";
let lastTitle = "";
let shuttingDown = false;
// A live video plays in the panel (stream mode): the page is about:blank.
let streaming = false;
// The video page of the stream, to go back to when the stream fails.
let streamUrl = "";
let streamLoggedIn = false;
// Waits for the panel's answer to play / pause / toggle, oldest first.
let panelAnswers = [];

// ---------- Chrome ----------

function userAgent() {
  let version = "157.0.0.0";
  try {
    version = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", `${CHROME_APP}/Contents/Info.plist`], {
      encoding: "utf8",
    }).trim();
  } catch {}
  const major = version.split(".")[0];
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// Chrome keeps a `SingletonLock` symlink ("<host>-<pid>") while a profile is open.
// The sign-in window of `--login` holds it until that Chrome quits; closing its
// window is not enough on macOS. Quit that Chrome here, and only that one: its
// command line must name this profile. A headless holder is the player of a
// helper: while its helper lives (parent is not pid 1) it belongs to another
// session and stays; an orphan is quit too.
async function releaseProfile() {
  let pid;
  try {
    pid = Number(fs.readlinkSync(path.join(profileDir, "SingletonLock")).split("-").pop());
    process.kill(pid, 0);
  } catch {
    return;
  }
  const command = execFileSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  if (!command.includes(`--user-data-dir=${profileDir}`)) {
    throw new Error("The YouTube profile is in use by another program.");
  }
  if (command.includes("--headless")) {
    const ppid = Number(execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
    if (ppid !== 1) throw new Error("YouTube is playing in another Claude session. Run /ctv off there first.");
    log("quitting an orphaned player Chrome, pid", pid);
  } else {
    log("quitting the sign-in Chrome, pid", pid);
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
  }
  throw new Error("The sign-in Chrome window did not quit. Quit it (Cmd+Q), then run /ctv again.");
}

async function startChrome() {
  const chromeArgs = [
    "--headless=new",
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    `--user-agent=${userAgent()}`,
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${scale}`,
  ];
  chromeArgs.push("about:blank");

  chrome = spawn(CHROME_BIN, chromeArgs, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  chrome.stderr.on("data", (d) => process.stderr.write(d));
  chrome.on("exit", (code, signal) => {
    if (shuttingDown) return;
    emit({ t: "error", message: `Chrome exited (code ${code}, signal ${signal})` });
    shutdown(1);
  });
  log("started Chrome pid", chrome.pid);

  cdp = new Cdp(chrome.stdio[3], chrome.stdio[4]);
  cdp.onClose = () => {
    if (shuttingDown) return;
    emit({ t: "error", message: "CDP connection closed" });
    shutdown(1);
  };
}

async function attachPage() {
  // The first request also waits for a cold Chrome start.
  const { targetInfos } = await cdp.send("Target.getTargets", {}, undefined, 60000);
  const page = targetInfos.find((t) => t.type === "page");
  targetId = page ? page.targetId : (await cdp.send("Target.createTarget", { url: "about:blank" })).targetId;
  ({ sessionId: session } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));

  cdp.on("Target.targetInfoChanged", ({ targetInfo }) => {
    if (targetInfo.targetId !== targetId) return;
    // In stream mode the page is about:blank; the video stays the page.
    if (streaming) return;
    if (targetInfo.url === lastUrl && targetInfo.title === lastTitle) return;
    lastUrl = targetInfo.url;
    lastTitle = targetInfo.title;
    emit({ t: "nav", url: lastUrl, title: lastTitle });
  });
  cdp.on("Page.screencastFrame", onFrame);

  await cdp.send("Target.setDiscoverTargets", { discover: true });
  await cdp.send("Page.enable", {}, session);
  await cdp.send("Runtime.enable", {}, session);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false }, session);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: VIDEO_ONLY }, session);
}

// On a watch page the view is the video alone: the player fills the viewport
// and the rest of the page is under it. Other pages (home, search) stay whole.
const VIDEO_ONLY = `(() => {
  const css = [
    "html.ctv-watch, html.ctv-watch body { overflow: hidden !important; }",
    "html.ctv-watch #movie_player { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2147483647 !important; background: #000 !important; }",
    "html.ctv-watch #movie_player .html5-video-container, html.ctv-watch #movie_player video { width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important; }",
    "html.ctv-watch #movie_player video { object-fit: contain !important; }",
    "html.ctv-watch #masthead-container { display: none !important; }",
  ].join("\\n");
  const apply = () => {
    const root = document.documentElement;
    if (!root) return;
    if (!document.getElementById("ctv-style")) {
      const style = document.createElement("style");
      style.id = "ctv-style";
      style.textContent = css;
      (document.head || root).appendChild(style);
    }
    root.classList.toggle("ctv-watch", location.pathname === "/watch");
    window.dispatchEvent(new Event("resize"));
  };
  // Muted is the helper's: every video that loads or plays stays silent.
  const hush = (e) => {
    if (window.__ctvMuted && e.target instanceof HTMLMediaElement) e.target.muted = true;
  };
  document.addEventListener("loadedmetadata", hush, true);
  document.addEventListener("play", hush, true);
  document.addEventListener("volumechange", hush, true);
  document.addEventListener("DOMContentLoaded", apply);
  document.addEventListener("yt-navigate-finish", apply);
  document.addEventListener("yt-page-data-updated", apply);
  apply();
})();`;

// ---------- frames ----------

function onFrame({ data, sessionId: frameSession }, sessionId) {
  cdp.send("Page.screencastFrameAck", { sessionId: frameSession }, sessionId).catch(() => {});
  lastRawFrameAt = performance.now();
  if (!casting) return;
  const now = performance.now();
  if (now - lastFrameAt < 1000 / MAX_FPS) return;
  lastFrameAt = now;
  frameToPanel(Buffer.from(data, "base64"));
}

// One frame on the panel's fd 3: a 4-byte big-endian length, then the JPEG.
// At most one frame waits in Node: while the pipe is full, new frames are
// dropped, and the panel shows the newest frame that got through.
function frameToPanel(image) {
  const stream = panel?.stdio[3];
  if (!stream || !stream.writable || panelBusy) return;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(image.length);
  if (stream.write(Buffer.concat([header, image]))) return;
  panelBusy = true;
  stream.once("drain", () => {
    panelBusy = false;
  });
}

function toPanel(line) {
  if (panel && panel.stdin.writable) panel.stdin.write(`${line}\n`);
}

async function ensurePanel() {
  if (args["no-panel"] || panel) return;
  const built = fs.existsSync(PANEL_BIN) && fs.statSync(PANEL_BIN).mtimeMs >= fs.statSync(PANEL_SRC).mtimeMs;
  if (!built) {
    log("building the panel");
    fs.mkdirSync(path.dirname(PANEL_BIN), { recursive: true });
    await promisify(execFile)("/usr/bin/swiftc", ["-O", PANEL_SRC, "-o", PANEL_BIN], { timeout: 180000 });
  }
  const child = spawn(PANEL_BIN, ["--width", String(width), "--height", String(height)], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.stderr.write(d));
  let rest = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text) => {
    const lines = (rest + text).split("\n");
    rest = lines.pop();
    for (const line of lines) if (line.trim()) onPanelLine(line);
  });
  child.stdin.on("error", () => {});
  child.stdio[3].on("error", () => {});
  child.on("exit", () => {
    if (panel !== child) return;
    panel = null;
    panelBusy = false;
    for (const answer of panelAnswers) answer(null);
    panelAnswers = [];
  });
  panel = child;
}

// The panel's stdout: stream state lines. The line after play / pause /
// toggle answers it; a failed stream goes back to the page.
function onPanelLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log("panel said:", line);
    return;
  }
  if (msg.t !== "stream") return;
  if (msg.state === "failed") {
    streamFailed(msg.message ?? "unknown error").catch((err) => log("cannot go back to the page:", err.message));
    return;
  }
  panelAnswers.shift()?.(msg.state);
}

// Sends play / pause / toggle to the panel and waits for the state after it
// (playing, paused or none); null when the panel does not answer.
function askPanel(command) {
  return new Promise((resolve) => {
    const answer = (state) => {
      clearTimeout(timer);
      resolve(state);
    };
    const timer = setTimeout(() => {
      panelAnswers = panelAnswers.filter((one) => one !== answer);
      resolve(null);
    }, PANEL_ANSWER_MS);
    panelAnswers.push(answer);
    toPanel(command);
  });
}

// Black and white: Chrome draws the whole page without color (its emulation of
// achromatopsia), so every frame and every later page is gray too.
async function setGray(on) {
  await cdp.send("Emulation.setEmulatedVisionDeficiency", { type: on ? "achromatopsia" : "none" }, session);
  if (streaming) toPanel(`gray ${on ? "on" : "off"}`);
  gray = on;
}

// Mute: a flag the page script reads, set again on every new document, and
// applied now to the videos already there. Unmute gives back YouTube's sound.
async function setMuted(on) {
  if (mutedScript !== null) {
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: mutedScript }, session);
  }
  ({ identifier: mutedScript } = await cdp.send(
    "Page.addScriptToEvaluateOnNewDocument",
    { source: `window.__ctvMuted = ${on};` },
    session,
  ));
  await evaluate(`(() => {
    window.__ctvMuted = ${on};
    for (const v of document.querySelectorAll("video, audio")) v.muted = ${on};
  })()`);
  if (streaming) toPanel(`mute ${on ? "on" : "off"}`);
  muted = on;
}

async function setCasting(on) {
  if (on) {
    await ensurePanel();
    toPanel("show");
  } else {
    toPanel("hide");
  }
  if (on === casting) return;
  // In stream mode the panel plays the stream: no screencast.
  if (!streaming) {
    if (on) {
      await startScreencast();
    } else {
      await cdp.send("Page.stopScreencast", {}, session);
    }
  }
  casting = on;
  if (on && !streaming) startWatchdog();
  else stopWatchdog();
}

async function startScreencast() {
  // Right after a navigation the page is between two renderers and Chrome
  // answers "Not attached to an active page": try again until it is there.
  for (let attempt = 0; ; attempt++) {
    try {
      await cdp.send(
        "Page.startScreencast",
        { format: "jpeg", quality: 80, maxWidth: Math.round(width * scale), maxHeight: Math.round(height * scale), everyNthFrame: 1 },
        session,
      );
      return;
    } catch (err) {
      if (attempt >= 40 || !/Not attached/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

// ---------- frame watchdog ----------

// A still page sends no frames, so a gap only counts while a video plays.
const VIDEO_PLAYING = `(() => { const v = document.querySelector("video"); return !!v && !v.paused && !v.ended && v.readyState >= 2; })()`;

function startWatchdog() {
  if (watchdog) return;
  lastRawFrameAt = performance.now();
  watchdog = setInterval(checkFrames, 1000);
  watchdog.unref();
}

function stopWatchdog() {
  clearInterval(watchdog);
  watchdog = null;
}

async function checkFrames() {
  if (!casting || streaming || watchdogBusy || shuttingDown) return;
  const gap = performance.now() - lastRawFrameAt;
  if (gap < FRAME_STALL_MS) return;
  watchdogBusy = true;
  try {
    let playing;
    try {
      playing = (await evaluate(VIDEO_PLAYING)) === true;
    } catch (err) {
      // No answer at all: the transport is dead, not only the screencast.
      if (err.message.startsWith("CDP timeout")) {
        emit({ t: "error", message: "Chrome stopped answering" });
        shutdown(1);
      }
      return;
    }
    if (!playing || !casting) return;
    log(`no frame for ${Math.round(gap)} ms while the video plays; restarting the screencast`);
    await cdp.send("Page.stopScreencast", {}, session);
    await startScreencast();
    lastRawFrameAt = performance.now();
  } catch (err) {
    log("cannot restart the screencast:", err.message);
  } finally {
    watchdogBusy = false;
  }
}

// ---------- page helpers ----------

async function evaluate(expression) {
  const res = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, session);
  return res.result?.value;
}

async function isLoggedIn() {
  try {
    return (
      (await evaluate(`(() => { try { return !!(window.ytcfg && window.ytcfg.get("LOGGED_IN")); } catch { return false; } })()`)) === true
    );
  } catch {
    return false;
  }
}

async function navigate(url) {
  const res = await cdp.send("Page.navigate", { url }, session);
  if (res.errorText) throw new Error(`navigate failed: ${res.errorText}`);
}

function waitForLoad(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      log("page load timed out; continuing");
      resolve();
    }, timeoutMs);
    const off = cdp.on("Page.loadEventFired", () => {
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

// ---------- live streams ----------

// The video id of a YouTube watch or live URL, else null.
function youtubeVideoId(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
  if (u.pathname === "/watch") return u.searchParams.get("v");
  return u.pathname.match(/^\/live\/([\w-]+)/)?.[1] ?? null;
}

// The player's data for video `id` (null while the player has another video
// or none): live, its HLS URL and its title. The player's getPlayerResponse is
// current after a YouTube navigation too; ytInitialPlayerResponse is not.
const LIVE_STREAM = (id) => `(() => {
  const r = document.getElementById("movie_player")?.getPlayerResponse?.();
  const d = r?.videoDetails;
  if (!d || d.videoId !== ${JSON.stringify(id)}) return null;
  const hls = r.streamingData?.hlsManifestUrl || "";
  const ended = !!r.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.endTimestamp;
  const live = !!hls && (d.isLive === true || (d.isLiveContent === true && !ended));
  return { live, hls, title: d.title || "" };
})()`;

// Waits for the player data of the video in `url`. Returns it when the video
// is live, else null.
async function findLiveStream(url) {
  const id = youtubeVideoId(url);
  if (!id) return null;
  const deadline = performance.now() + LIVE_CHECK_MS;
  while (performance.now() < deadline) {
    let found = null;
    try {
      found = await evaluate(LIVE_STREAM(id));
    } catch {}
    if (found) return found.live ? found : null;
    await new Promise((r) => setTimeout(r, 250));
  }
  log("no player data for", id, "; showing the page");
  return null;
}

// Stream mode: the panel plays the HLS URL, the page goes to about:blank so
// it does not decode the video or play its sound too. The video stays the
// page (lastUrl, lastTitle).
async function startStream(live) {
  await ensurePanel();
  if (!panel) return false;
  const page = await evaluate(`({ url: location.href, title: document.title })`);
  streamUrl = page?.url || lastUrl;
  streamLoggedIn = await isLoggedIn();
  const title = page?.title && page.title !== "YouTube" ? page.title : live.title;
  toPanel(`mute ${muted ? "on" : "off"}`);
  toPanel(`gray ${gray ? "on" : "off"}`);
  toPanel(`stream ${live.hls}`);
  streaming = true;
  stopWatchdog();
  if (casting) await cdp.send("Page.stopScreencast", {}, session);
  if (streamUrl !== lastUrl || title !== lastTitle) {
    lastUrl = streamUrl;
    lastTitle = title;
    emit({ t: "nav", url: lastUrl, title: lastTitle });
  }
  await navigate("about:blank");
  return true;
}

// Leaves stream mode; the page shows again when the view is cast.
async function stopStream() {
  if (!streaming) return;
  toPanel("stream-stop");
  streaming = false;
  if (casting) {
    await startScreencast();
    startWatchdog();
  }
}

async function streamFailed(message) {
  if (!streaming) return;
  emit({ t: "error", message: `Live stream failed, playing in the page instead: ${message}` });
  await stopStream();
  await navigate(streamUrl);
}

// Leaves stream mode, loads `url`, and plays it in the panel when it is a live
// video. Returns whether it streams.
async function openUrl(url) {
  await stopStream();
  await navigate(url);
  const live = args["no-panel"] ? null : await findLiveStream(url);
  return live ? startStream(live) : false;
}

// ---------- video list ----------

// Reads the videos a YouTube page (home, search) holds in `ytInitialData`:
// the page's own data, there before anything is drawn.
const LIST_VIDEOS = `(() => {
  const items = [];
  const seen = new Set();
  const text = (t) => (!t ? "" : t.simpleText ?? t.content ?? (t.runs || []).map((r) => r.text).join(""));
  const add = (id, title, channel, length) => {
    if (!id || !title || seen.has(id)) return;
    seen.add(id);
    items.push({ id, title, channel: channel || "", length: length || "" });
  };
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 60) return;
    if (Array.isArray(node)) {
      for (const one of node) walk(one, depth + 1);
      return;
    }
    const v = node.videoRenderer || node.compactVideoRenderer;
    if (v && v.videoId) add(v.videoId, text(v.title), text(v.ownerText || v.longBylineText || v.shortBylineText), text(v.lengthText));
    const l = node.lockupViewModel;
    if (l && l.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
      const m = l.metadata && l.metadata.lockupMetadataViewModel;
      const rows = m && m.metadata && m.metadata.contentMetadataViewModel && m.metadata.contentMetadataViewModel.metadataRows;
      const part = rows && rows[0] && rows[0].metadataParts && rows[0].metadataParts[0];
      add(l.contentId, text(m && m.title), text(part && part.text), "");
    }
    for (const key in node) walk(node[key], depth + 1);
  };
  walk(window.ytInitialData, 0);
  let loggedIn = false;
  try {
    loggedIn = !!(window.ytcfg && window.ytcfg.get("LOGGED_IN"));
  } catch {}
  return { items: items.slice(0, 15), loggedIn };
})()`;

const TOGGLE_PLAY = `(() => {
  const v = document.querySelector("video");
  if (!v) return null;
  if (v.paused) v.play(); else v.pause();
  return v.paused;
})()`;

// Loads `url` in a tab of its own, so a video in the view keeps playing.
async function listVideos(url) {
  const { targetId: tab } = await cdp.send("Target.createTarget", { url: "about:blank", background: true });
  let off = () => {};
  try {
    const { sessionId: tabSession } = await cdp.send("Target.attachToTarget", { targetId: tab, flatten: true });
    await cdp.send("Page.enable", {}, tabSession);
    const parsed = new Promise((resolve) => {
      const timer = setTimeout(resolve, 15000);
      off = cdp.on("Page.domContentEventFired", (_params, from) => {
        if (from !== tabSession) return;
        clearTimeout(timer);
        resolve();
      });
    });
    const res = await cdp.send("Page.navigate", { url }, tabSession);
    if (res.errorText) throw new Error(`navigate failed: ${res.errorText}`);
    await parsed;
    const out = await cdp.send("Runtime.evaluate", { expression: LIST_VIDEOS, returnByValue: true }, tabSession);
    return out.result?.value ?? { items: [], loggedIn: false };
  } finally {
    off();
    await cdp.send("Target.closeTarget", { targetId: tab }).catch(() => {});
  }
}

// ---------- input ----------

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

const NAMED_KEYS = {
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  " ": { key: " ", code: "Space", vk: 32, text: " " },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
};
const KEY_ALIASES = { arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", esc: "escape", del: "delete" };

const PUNCT_CODES = {
  "-": ["Minus", 189], "_": ["Minus", 189], "=": ["Equal", 187], "+": ["Equal", 187],
  "[": ["BracketLeft", 219], "{": ["BracketLeft", 219], "]": ["BracketRight", 221], "}": ["BracketRight", 221],
  "\\": ["Backslash", 220], "|": ["Backslash", 220], ";": ["Semicolon", 186], ":": ["Semicolon", 186],
  "'": ["Quote", 222], '"': ["Quote", 222], ",": ["Comma", 188], "<": ["Comma", 188],
  ".": ["Period", 190], ">": ["Period", 190], "/": ["Slash", 191], "?": ["Slash", 191],
  "`": ["Backquote", 192], "~": ["Backquote", 192],
  "!": ["Digit1", 49], "@": ["Digit2", 50], "#": ["Digit3", 51], "$": ["Digit4", 52], "%": ["Digit5", 53],
  "^": ["Digit6", 54], "&": ["Digit7", 55], "*": ["Digit8", 56], "(": ["Digit9", 57], ")": ["Digit0", 48],
};

function describeKey(raw) {
  if ([...raw].length === 1 && raw !== " ") {
    const ch = raw;
    if (/^[a-z]$/i.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: ch };
    if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), text: ch };
    const p = PUNCT_CODES[ch];
    return { key: ch, code: p ? p[0] : "", vk: p ? p[1] : 0, text: ch };
  }
  const norm = raw.toLowerCase().replace(/[\s_-]/g, "");
  const named = NAMED_KEYS[KEY_ALIASES[norm] ?? norm] ?? NAMED_KEYS[raw];
  if (!named) throw new Error(`unknown key: ${JSON.stringify(raw)}`);
  return named;
}

async function sendKey(ev) {
  const k = describeKey(String(ev.key));
  const modifiers = (ev.ctrl ? MOD.ctrl : 0) | (ev.shift ? MOD.shift : 0) | (ev.meta ? MOD.meta : 0);
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers };
  const typesText = k.text && !ev.ctrl && !ev.meta;
  if (typesText) {
    await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown", text: k.text, unmodifiedText: k.text }, session);
  } else {
    await cdp.send("Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" }, session);
  }
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" }, session);
}

async function sendInput(ev) {
  if (ev.k === "pointer") {
    const x = Number(ev.x) * width;
    const y = Number(ev.y) * height;
    if (ev.type === "down") {
      pointerDown = true;
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, session);
    } else if (ev.type === "up") {
      pointerDown = false;
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, session);
    } else if (ev.type === "move") {
      await cdp.send(
        "Input.dispatchMouseEvent",
        { type: "mouseMoved", x, y, button: pointerDown ? "left" : "none", buttons: pointerDown ? 1 : 0 },
        session,
      );
    } else {
      throw new Error(`unknown pointer type: ${ev.type}`);
    }
  } else if (ev.k === "wheel") {
    const x = Number(ev.x) * width;
    const y = Number(ev.y) * height;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: Number(ev.dy) || 0 }, session);
  } else if (ev.k === "key") {
    await sendKey(ev);
  } else {
    throw new Error(`unknown event kind: ${ev.k}`);
  }
}

// ---------- control socket ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

function reply(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function handle(req, res) {
  const route = `${req.method} ${req.url}`;
  const body = req.method === "POST" ? await readBody(req) : {};
  switch (route) {
    case "POST /navigate":
      if (typeof body.url !== "string") throw new Error("url is required");
      return reply(res, 200, { ok: true, streaming: await openUrl(body.url) });
    case "POST /input":
      // The panel plays the stream: there is no page to send input to.
      if (streaming) return reply(res, 200, { ok: true });
      for (const ev of body.events ?? []) await sendInput(ev);
      return reply(res, 200, { ok: true });
    case "POST /cast":
      await setCasting(Boolean(body.on));
      return reply(res, 200, { ok: true, casting });
    case "POST /list":
      if (typeof body.url !== "string") throw new Error("url is required");
      return reply(res, 200, { ok: true, ...(await listVideos(body.url)) });
    case "POST /gray":
      await setGray(typeof body.on === "boolean" ? body.on : !gray);
      return reply(res, 200, { ok: true, gray });
    case "POST /mute":
      await setMuted(typeof body.on === "boolean" ? body.on : !muted);
      return reply(res, 200, { ok: true, muted });
    case "POST /resize":
      if (typeof body.factor !== "number" || !(body.factor > 0)) throw new Error("factor is required");
      await ensurePanel();
      toPanel(`resize ${body.factor}`);
      return reply(res, 200, { ok: true });
    case "POST /toggle":
      if (streaming) {
        const state = await askPanel("toggle");
        if (state === null) throw new Error("the panel did not answer");
        return reply(res, 200, { ok: true, paused: state === "none" ? null : state === "paused" });
      }
      return reply(res, 200, { ok: true, paused: await evaluate(TOGGLE_PLAY) });
    case "GET /state":
      return reply(res, 200, {
        ok: true,
        url: lastUrl,
        title: lastTitle,
        loggedIn: streaming ? streamLoggedIn : await isLoggedIn(),
        casting,
        streaming,
      });
    case "POST /quit":
      reply(res, 200, { ok: true });
      res.on("finish", () => shutdown(0));
      return;
    default:
      return reply(res, 404, { ok: false, error: `no route ${route}` });
  }
}

function startServer() {
  fs.rmSync(sockPath, { force: true });
  server = http.createServer((req, res) => {
    handle(req, res).catch((err) => reply(res, 400, { ok: false, error: err.message }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // macOS cuts a socket path to 103 bytes without an error, so a long path
    // binds relative to the run dir (bind happens inside listen()).
    if (Buffer.byteLength(sockPath) > SUN_PATH_MAX) {
      const cwd = process.cwd();
      process.chdir(runDir);
      try {
        server.listen("control.sock", resolve);
      } finally {
        process.chdir(cwd);
      }
    } else {
      server.listen(sockPath, resolve);
    }
  });
}

// ---------- lifetime ----------

function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopWatchdog();
  try {
    server?.close();
  } catch {}
  fs.rmSync(sockPath, { force: true });
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    if (cdp) {
      await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    }
    if (!(await waitForExit(chrome, 3000))) {
      chrome.kill("SIGTERM");
      if (!(await waitForExit(chrome, 2000))) {
        chrome.kill("SIGKILL");
        await waitForExit(chrome, 2000);
      }
    }
  }
  cdp?.close();
  if (panel) {
    panel.stdin.end();
    panel.stdio[3].end();
    panel.kill("SIGTERM");
  }
  try {
    fs.rmdirSync(runDir);
  } catch {}
  process.exit(code);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
// The mod starts the helper with stdin already at end of file, so stdin cannot
// tell that the parent is gone. A parent that died leaves this process to pid 1.
const parentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== parentPid) shutdown(0);
}, 2000).unref();

// ---------- main ----------

async function main() {
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  await releaseProfile();
  await startChrome();
  await attachPage();
  if (args.gray) await setGray(true);
  if (args.mute) await setMuted(true);
  await startServer();
  // No frames until the mod shows the view (POST /cast).
  if (args.url !== "about:blank") {
    const loaded = waitForLoad(30000);
    await navigate(args.url);
    await loaded;
  }
  emit({ t: "ready" });
}

main().catch((err) => {
  emit({ t: "error", message: err.message });
  shutdown(1);
});
