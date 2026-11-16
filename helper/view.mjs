#!/usr/bin/env node
// ctv view: headless Chrome, its page sent as JPEG frames to the panel; Twitch plays in the panel.
// stdout: one JSON line per event (ready / nav / error); stderr: diagnostics.
// control: HTTP server on <run-dir>/control.sock.
// panel: commands on stdin, stream state on stdout, frames on fd 3 (4-byte BE length + JPEG).

import { spawn, execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

if (process.platform !== "darwin") {
  emit({ t: "error", message: "ctv supports macOS only." });
  process.exit(2);
}

const CHROME_APP = "/Applications/Google Chrome.app";
const CHROME_BIN = `${CHROME_APP}/Contents/MacOS/Google Chrome`;
const LOGIN_URL =
  "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F";
const TWITCH_LOGIN_URL = "https://www.twitch.tv/login";
// The Client-ID of Twitch's own web player (Streamlink sends it too).
const TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
// GQL requests run in a twitch.tv document so they carry the person's Twitch cookies.
const TWITCH_PAGE = "https://www.twitch.tv/robots.txt";
// This page's own GQL request carries the hash of the following query.
const TWITCH_FOLLOWING_PAGE = "https://www.twitch.tv/directory/following/live";
// First path parts of twitch.tv that are not a channel.
const TWITCH_RESERVED = new Set(
  (
    "directory videos settings search downloads p subscriptions inventory wallet drops friends " +
    "messages payments prime turbo jobs store login signup logout popout moderator embed " +
    "broadcast u privacy team products bits following clips redeem"
  ).split(" "),
);
const MAX_FPS = 24;
const CDP_TIMEOUT_MS = 10000;
// Chrome stops the screencast when it waits for acks; a longer gap while a video plays restarts it.
const FRAME_STALL_MS = 3000;
const PANEL_ANSWER_MS = 3000;
const PANEL_SRC = path.join(import.meta.dirname, "panel.swift");
const DATA_DIR = path.join(os.homedir(), "Library/Application Support/ctv");
// Outside the mod folder, so building the panel does not reload the mod.
const PANEL_BIN = path.join(DATA_DIR, "ctv-panel");
const SUN_PATH_MAX = 103;

// The mod was named yt-corner: keep its profile (and Google sign-in); the panel is built again.
const OLD_DATA_DIR = path.join(os.homedir(), "Library/Application Support/yt-corner");
if (!fs.existsSync(DATA_DIR) && fs.existsSync(OLD_DATA_DIR)) {
  fs.renameSync(OLD_DATA_DIR, DATA_DIR);
  fs.rmSync(path.join(DATA_DIR, "yt-panel"), { force: true });
}

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
    "login-twitch": { type: "boolean", default: false },
  },
});

// A normal visible Chrome without debugging flags: Google refuses sign-in in an automated browser.
if (args.login || args["login-twitch"]) {
  fs.mkdirSync(path.resolve(args.profile), { recursive: true });
  execFileSync("/usr/bin/open", [
    "-na",
    CHROME_APP,
    "--args",
    `--user-data-dir=${path.resolve(args.profile)}`,
    "--no-first-run",
    "--no-default-browser-check",
    args["login-twitch"] ? TWITCH_LOGIN_URL : LOGIN_URL,
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

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function log(...parts) {
  process.stderr.write(`[ctv-view] ${parts.join(" ")}\n`);
}

// --remote-debugging-pipe: commands on fd 3, replies and events on fd 4, each JSON text + NUL.
class Cdp {
  constructor(output, input) {
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    // Bytes stay Buffers until the NUL, so a UTF-8 character split between reads stays whole.
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
let panelBusy = false;
let watchdog = null;
let watchdogBusy = false;
let pointerDown = false;
let lastUrl = "";
let lastTitle = "";
let shuttingDown = false;
let streaming = false;
let streamUrl = "";
let streamLoggedIn = false;
let panelAnswers = [];

function userAgent() {
  let version = "157.0.0.0";
  try {
    version = execFileSync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleShortVersionString", "raw", `${CHROME_APP}/Contents/Info.plist`],
      { encoding: "utf8" },
    ).trim();
  } catch {}
  const major = version.split(".")[0];
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// The --login Chrome holds SingletonLock until it quits; closing its window is not enough on macOS.
// A headless holder whose helper still lives (ppid is not 1) belongs to another session.
async function releaseProfile() {
  let pid;
  try {
    pid = Number(fs.readlinkSync(path.join(profileDir, "SingletonLock")).split("-").pop());
    process.kill(pid, 0);
  } catch {
    return;
  }
  const ps = (field) =>
    execFileSync("/bin/ps", ["-ww", "-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" });
  const command = ps("command");
  if (!command.includes(`--user-data-dir=${profileDir}`)) {
    throw new Error("The YouTube profile is in use by another program.");
  }
  if (command.includes("--headless")) {
    if (Number(ps("ppid").trim()) !== 1) {
      throw new Error("YouTube is playing in another Claude session. Run /ctv off there first.");
    }
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

function startChrome() {
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
    "about:blank",
  ];
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
  // The long timeout covers a cold Chrome start.
  const { targetInfos } = await cdp.send("Target.getTargets", {}, undefined, 60000);
  const page = targetInfos.find((t) => t.type === "page");
  targetId = page
    ? page.targetId
    : (await cdp.send("Target.createTarget", { url: "about:blank" })).targetId;
  ({ sessionId: session } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));

  cdp.on("Target.targetInfoChanged", ({ targetInfo }) => {
    // In stream mode the page is about:blank and the stream's page stays the reported one.
    if (targetInfo.targetId !== targetId || streaming) return;
    if (targetInfo.url === lastUrl && targetInfo.title === lastTitle) return;
    lastUrl = targetInfo.url;
    lastTitle = targetInfo.title;
    emit({ t: "nav", url: lastUrl, title: lastTitle });
  });
  cdp.on("Page.screencastFrame", onFrame);

  await cdp.send("Target.setDiscoverTargets", { discover: true });
  await cdp.send("Page.enable", {}, session);
  await cdp.send("Runtime.enable", {}, session);
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: scale, mobile: false },
    session,
  );
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: VIDEO_ONLY }, session);
}

// On a YouTube watch page or a Twitch channel / video page the player fills the viewport.
const VIDEO_ONLY = `(() => {
  const reserved = new Set(${JSON.stringify([...TWITCH_RESERVED])});
  const css = [
    "html.ctv-watch, html.ctv-watch body { overflow: hidden !important; }",
    "html.ctv-watch #movie_player { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2147483647 !important; background: #000 !important; }",
    "html.ctv-watch #movie_player .html5-video-container, html.ctv-watch #movie_player video { width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important; }",
    "html.ctv-watch #movie_player video { object-fit: contain !important; }",
    "html.ctv-watch #masthead-container { display: none !important; }",
    "html.ctv-twitch, html.ctv-twitch body { overflow: hidden !important; }",
    "html.ctv-twitch .video-player { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2147483647 !important; background: #000 !important; }",
    "html.ctv-twitch .video-player video { width: 100% !important; height: 100% !important; object-fit: contain !important; }",
  ].join("\\n");
  const twitchPlayer = () => {
    if (!/(^|\\.)twitch\\.tv$/.test(location.hostname)) return false;
    const m = location.pathname.match(/^\\/(\\w+)(\\/\\d+)?\\/?$/);
    return !!m && (m[1] === "videos" ? !!m[2] : !m[2] && !reserved.has(m[1].toLowerCase()));
  };
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
    root.classList.toggle("ctv-twitch", twitchPlayer());
    window.dispatchEvent(new Event("resize"));
  };
  // The page unmutes its own videos; while the helper mutes, every load or play goes silent again.
  const hush = (e) => {
    if (window.__ctvMuted && e.target instanceof HTMLMediaElement) e.target.muted = true;
  };
  document.addEventListener("loadedmetadata", hush, true);
  document.addEventListener("play", hush, true);
  document.addEventListener("volumechange", hush, true);
  document.addEventListener("DOMContentLoaded", apply);
  document.addEventListener("yt-navigate-finish", apply);
  document.addEventListener("yt-page-data-updated", apply);
  // Twitch moves between pages with history.pushState and fires no event.
  if (/(^|\\.)twitch\\.tv$/.test(location.hostname)) {
    let shown = location.pathname;
    setInterval(() => {
      if (location.pathname === shown) return;
      shown = location.pathname;
      apply();
    }, 1000);
  }
  apply();
})();`;

function onFrame({ data, sessionId: frameSession }, sessionId) {
  cdp.send("Page.screencastFrameAck", { sessionId: frameSession }, sessionId).catch(() => {});
  const now = performance.now();
  lastRawFrameAt = now;
  if (!casting || now - lastFrameAt < 1000 / MAX_FPS) return;
  lastFrameAt = now;
  frameToPanel(Buffer.from(data, "base64"));
}

// While the pipe is full new frames are dropped, so no backlog builds up in Node.
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
  const built =
    fs.existsSync(PANEL_BIN) && fs.statSync(PANEL_BIN).mtimeMs >= fs.statSync(PANEL_SRC).mtimeMs;
  if (!built) {
    log("building the panel");
    fs.mkdirSync(path.dirname(PANEL_BIN), { recursive: true });
    await promisify(execFile)("/usr/bin/swiftc", ["-O", PANEL_SRC, "-o", PANEL_BIN], {
      timeout: 180000,
    });
  }
  const child = spawn(PANEL_BIN, ["--width", String(width), "--height", String(height)], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
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

// A stream state line answers the oldest askPanel; "failed" goes back to the page.
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
    streamFailed(msg.message ?? "unknown error").catch((err) =>
      log("cannot go back to the page:", err.message),
    );
    return;
  }
  panelAnswers.shift()?.(msg.state);
}

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

async function setGray(on) {
  await cdp.send(
    "Emulation.setEmulatedVisionDeficiency",
    { type: on ? "achromatopsia" : "none" },
    session,
  );
  if (streaming) toPanel(`gray ${on ? "on" : "off"}`);
  gray = on;
}

async function setMuted(on) {
  if (mutedScript !== null) {
    await cdp.send(
      "Page.removeScriptToEvaluateOnNewDocument",
      { identifier: mutedScript },
      session,
    );
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
  if (on) await ensurePanel();
  toPanel(on ? "show" : "hide");
  if (on === casting) return;
  if (!streaming) {
    if (on) await startScreencast();
    else await cdp.send("Page.stopScreencast", {}, session);
  }
  casting = on;
  if (on && !streaming) startWatchdog();
  else stopWatchdog();
}

async function startScreencast() {
  const params = {
    format: "jpeg",
    quality: 80,
    maxWidth: Math.round(width * scale),
    maxHeight: Math.round(height * scale),
    everyNthFrame: 1,
  };
  // Right after a navigation the page is between renderers and Chrome answers "Not attached".
  for (let attempt = 0; ; attempt++) {
    try {
      await cdp.send("Page.startScreencast", params, session);
      return;
    } catch (err) {
      if (attempt >= 40 || !/Not attached/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

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

async function evaluate(expression) {
  const res = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, session);
  return res.result?.value;
}

async function isLoggedIn() {
  try {
    return (
      (await evaluate(`(() => { try {
        if (/(^|\\.)twitch\\.tv$/.test(location.hostname)) return /(?:^|; )auth-token=/.test(document.cookie);
        return !!(window.ytcfg && window.ytcfg.get("LOGGED_IN"));
      } catch { return false; } })()`)) === true
    );
  } catch {
    return false;
  }
}

async function navigate(url, sessionId = session) {
  const res = await cdp.send("Page.navigate", { url }, sessionId);
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

// The page goes to about:blank so it does not decode the video or play its sound too.
async function startStream(stream) {
  await ensurePanel();
  const wasStreaming = streaming;
  streamUrl = stream.url;
  streamLoggedIn = stream.loggedIn;
  toPanel(`mute ${muted ? "on" : "off"}`);
  toPanel(`gray ${gray ? "on" : "off"}`);
  toPanel(`stream ${stream.hls}`);
  streaming = true;
  stopWatchdog();
  if (casting && !wasStreaming) await cdp.send("Page.stopScreencast", {}, session);
  if (stream.url !== lastUrl || stream.title !== lastTitle) {
    lastUrl = stream.url;
    lastTitle = stream.title;
    emit({ t: "nav", url: lastUrl, title: lastTitle });
  }
  await navigate("about:blank");
}

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
  emit({ t: "error", message: `The stream failed, playing in the page instead: ${message}` });
  await stopStream();
  await navigate(streamUrl);
}

// The Twitch stream is found before anything changes, so an offline channel leaves the view as is.
async function openUrl(url) {
  const twitch = args["no-panel"] ? null : twitchTarget(url);
  if (!twitch) {
    await stopStream();
    await navigate(url);
    return false;
  }
  await startStream(await findTwitchStream(twitch));
  return true;
}

function twitchTarget(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^(www\.)?twitch\.tv$/.test(u.hostname)) return null;
  const vod = u.pathname.match(/^\/videos\/(\d+)\/?$/)?.[1];
  if (vod) return { vod };
  const login = u.pathname.match(/^\/(\w{1,25})\/?$/)?.[1]?.toLowerCase();
  return login && !TWITCH_RESERVED.has(login) ? { login } : null;
}

const PLAYBACK_ACCESS_TOKEN = `query PlaybackAccessToken($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {
  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature }
  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature }
}`;
const TWITCH_CHANNEL = `query($login: String!) { user(login: $login) { displayName stream { title } } }`;
const TWITCH_VIDEO = `query($id: ID!) { video(id: $id) { title owner { displayName } } }`;
const TWITCH_SEARCH = `query($query: String!) { searchStreams(userQuery: $query, first: 15) { edges { node { title viewersCount game { displayName } broadcaster { login displayName } } } } }`;
// A plain follows query gets "service error"; only the web client's persisted query works.
const TWITCH_FOLLOWED_OPERATION = "FollowingLive_CurrentUser";
let twitchFollowHash =
  process.env.CTV_TWITCH_FOLLOW_HASH ||
  "bbfa83064e90280dce3eaa9de3a18eb6647505546336313241afdf569b6b34b6";
const twitchFollowed = () => ({
  operationName: TWITCH_FOLLOWED_OPERATION,
  variables: { imageWidth: 50, limit: 30, includeCostreaming: false },
  extensions: { persistedQuery: { version: 1, sha256Hash: twitchFollowHash } },
});

// Like Twitch's web player: its Client-ID, plus the auth-token when signed in (Turbo: no ads).
const TWITCH_GQL = (requests) => `(async () => {
  const token = (document.cookie.match(/(?:^|; )auth-token=([^;]*)/) || [])[1] || "";
  const headers = { "Client-ID": ${JSON.stringify(TWITCH_CLIENT_ID)} };
  if (token) headers.Authorization = "OAuth " + token;
  const res = await fetch("https://gql.twitch.tv/gql", { method: "POST", headers, body: ${JSON.stringify(JSON.stringify(requests))} });
  if (!res.ok) return { error: "Twitch answered " + res.status };
  return { loggedIn: !!token, results: await res.json() };
})()`;

async function twitchGql(requests) {
  const out = await evaluateInTab(TWITCH_PAGE, TWITCH_GQL(requests));
  if (!out || out.error) throw new Error(out?.error ?? "Twitch did not answer");
  for (const one of out.results) {
    if (one.errors?.length) throw new Error(`Twitch: ${one.errors[0].message}`);
  }
  return { loggedIn: out.loggedIn, data: out.results.map((one) => one.data) };
}

async function twitchFollowedGql() {
  try {
    return await twitchGql([twitchFollowed()]);
  } catch (err) {
    if (!/PersistedQuery/i.test(err.message)) throw err;
    log(
      `Twitch refused the following query (${err.message}); reading its hash from the following page`,
    );
  }
  const hash = await findTwitchFollowHash();
  if (!hash) throw new Error("Twitch changed its following query; update ctv.");
  twitchFollowHash = hash;
  return twitchGql([twitchFollowed()]);
}

function findTwitchFollowHash() {
  return withTab(async (tabSession, on) => {
    await cdp.send("Network.enable", {}, tabSession);
    const hash = new Promise((resolve) => {
      const timer = setTimeout(resolve, 15000, null);
      on("Network.requestWillBeSent", ({ request }) => {
        if (!request.url.startsWith("https://gql.twitch.tv/gql")) return;
        let body;
        try {
          body = JSON.parse(request.postData ?? "null");
        } catch {
          return;
        }
        const one = [body].flat().find((op) => op?.operationName === TWITCH_FOLLOWED_OPERATION);
        const found = one?.extensions?.persistedQuery?.sha256Hash;
        if (!found) return;
        clearTimeout(timer);
        resolve(found);
      });
    });
    await navigate(TWITCH_FOLLOWING_PAGE, tabSession);
    return await hash;
  });
}

async function findTwitchStream({ login, vod }) {
  const isVod = Boolean(vod);
  const {
    loggedIn,
    data: [access, info],
  } = await twitchGql([
    {
      operationName: "PlaybackAccessToken",
      query: PLAYBACK_ACCESS_TOKEN,
      variables: {
        isLive: !isVod,
        login: login ?? "",
        isVod,
        vodID: vod ?? "",
        playerType: "site",
      },
    },
    isVod
      ? { query: TWITCH_VIDEO, variables: { id: vod } }
      : { query: TWITCH_CHANNEL, variables: { login } },
  ]);
  let token, base, url, title;
  if (isVod) {
    if (!info.video) throw new Error(`video ${vod} does not exist`);
    token = access.videoPlaybackAccessToken;
    base = `https://usher.ttvnw.net/vod/${vod}.m3u8`;
    url = `https://www.twitch.tv/videos/${vod}`;
    title = `${info.video.title} · ${info.video.owner?.displayName ?? "Twitch"}`;
  } else {
    if (!info.user) throw new Error(`${login} does not exist`);
    if (!info.user.stream) throw new Error(`${login} is offline`);
    token = access.streamPlaybackAccessToken;
    base = `https://usher.ttvnw.net/api/channel/hls/${login}.m3u8`;
    url = `https://www.twitch.tv/${login}`;
    title = `${info.user.stream.title} · ${info.user.displayName}`;
  }
  if (!token) throw new Error("Twitch gave no playback token");
  const hls =
    `${base}?sig=${token.signature}&token=${encodeURIComponent(token.value)}` +
    `&allow_source=true&allow_audio_only=true&fast_bread=true&p=${Math.floor(Math.random() * 1e7)}` +
    "&player_type=site&supported_codecs=h264";
  // Usher answers 404 for a channel that went offline after the check above.
  const res = await fetch(hls, { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) });
  await res.body?.cancel();
  if (res.status === 404 && !isVod) throw new Error(`${login} is offline`);
  if (!res.ok) throw new Error(`Twitch refused the stream (${res.status})`);
  return { hls, url, title, loggedIn };
}

async function signedIn() {
  const { cookies } = await cdp.send("Storage.getCookies");
  const has = (names, domain) =>
    cookies.some((c) => names.includes(c.name) && domain.test(c.domain));
  return {
    youtube: has(["SAPISID", "__Secure-3PSID"], /(^|\.)(google|youtube)\.com$/),
    twitch: has(["auth-token"], /(^|\.)twitch\.tv$/),
  };
}

async function listTwitch(query) {
  // Signed out, there are no follows to ask for (and no hash to recover).
  if (!query && !(await signedIn()).twitch) return { items: [], loggedIn: false };
  const { loggedIn, data } = query
    ? await twitchGql([{ query: TWITCH_SEARCH, variables: { query } }])
    : await twitchFollowedGql();
  const users = query
    ? (data[0].searchStreams?.edges ?? []).map(
        ({ node }) => node.broadcaster && { ...node.broadcaster, stream: node },
      )
    : (data[0].currentUser?.followedLiveUsers?.edges ?? []).map(({ node }) => node);
  const items = users
    .filter((user) => user?.stream)
    .toSorted((a, b) => b.stream.viewersCount - a.stream.viewersCount)
    .slice(0, 15)
    .map(({ login, displayName, stream }) => ({
      id: login,
      title: stream.title || "",
      channel: stream.game?.displayName
        ? `${displayName} · ${stream.game.displayName}`
        : displayName,
      length: `${stream.viewersCount.toLocaleString("en-US")} watching`,
      url: `https://www.twitch.tv/${login}`,
    }));
  return { items, loggedIn };
}

// ytInitialData is the page's own data, there before anything is drawn.
const LIST_VIDEOS = (live) => `((live) => {
  const items = [];
  const isLive = (item) =>
    /"(BADGE_STYLE_TYPE_LIVE_NOW|THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE)"|"style":"LIVE"/.test(JSON.stringify(item));
  const seen = new Set();
  const text = (t) => (!t ? "" : t.simpleText ?? t.content ?? (t.runs || []).map((r) => r.text).join(""));
  const add = (id, title, channel, length) => {
    if (!id || !title || seen.has(id)) return;
    seen.add(id);
    items.push({ id, title, channel: channel || "", length: length || "", url: "https://www.youtube.com/watch?v=" + id });
  };
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 60) return;
    if (Array.isArray(node)) {
      for (const one of node) walk(one, depth + 1);
      return;
    }
    const v = node.videoRenderer || node.compactVideoRenderer;
    if (v && v.videoId && (!live || isLive(v))) add(v.videoId, text(v.title), text(v.ownerText || v.longBylineText || v.shortBylineText), text(v.lengthText));
    const l = node.lockupViewModel;
    if (l && l.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" && (!live || isLive(l))) {
      const m = l.metadata && l.metadata.lockupMetadataViewModel;
      const rows = m && m.metadata && m.metadata.contentMetadataViewModel && m.metadata.contentMetadataViewModel.metadataRows;
      const part = rows && rows[0] && rows[0].metadataParts && rows[0].metadataParts[0];
      // The duration is a thumbnail badge (a live item has a "LIVE" badge instead).
      const badge = JSON.stringify(l.contentImage || {}).match(/"text":"(\\d+(?::\\d\\d)+)"/);
      add(l.contentId, text(m && m.title), text(part && part.text), badge ? badge[1] : "");
    }
    for (const key in node) walk(node[key], depth + 1);
  };
  walk(window.ytInitialData, 0);
  let loggedIn = false;
  try {
    loggedIn = !!(window.ytcfg && window.ytcfg.get("LOGGED_IN"));
  } catch {}
  return { items: items.slice(0, 15), loggedIn };
})(${live})`;

const TOGGLE_PLAY = `(() => {
  const v = document.querySelector("video");
  if (!v) return null;
  if (v.paused) v.play(); else v.pause();
  return v.paused;
})()`;

// A background tab of its own, so a video in the view keeps playing.
async function withTab(fn) {
  const { targetId: tab } = await cdp.send("Target.createTarget", {
    url: "about:blank",
    background: true,
  });
  const offs = [];
  try {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: tab, flatten: true });
    const on = (method, handler) =>
      offs.push(cdp.on(method, (params, from) => from === sessionId && handler(params)));
    return await fn(sessionId, on);
  } finally {
    for (const off of offs) off();
    await cdp.send("Target.closeTarget", { targetId: tab }).catch(() => {});
  }
}

function evaluateInTab(url, expression) {
  return withTab(async (tabSession, on) => {
    await cdp.send("Page.enable", {}, tabSession);
    const parsed = new Promise((resolve) => {
      const timer = setTimeout(resolve, 15000);
      on("Page.domContentEventFired", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await navigate(url, tabSession);
    await parsed;
    const out = await cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      tabSession,
    );
    if (out.exceptionDetails) {
      throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
    }
    return out.result?.value;
  });
}

async function listVideos(url, live) {
  return (await evaluateInTab(url, LIST_VIDEOS(live))) ?? { items: [], loggedIn: false };
}

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

const NAMED_KEYS = {
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
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
const KEY_ALIASES = {
  enter: "return",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  esc: "escape",
  del: "delete",
};

const PUNCT_CODES = Object.fromEntries([
  ...[
    ["-_", "Minus", 189],
    ["=+", "Equal", 187],
    ["[{", "BracketLeft", 219],
    ["]}", "BracketRight", 221],
    ["\\|", "Backslash", 220],
    [";:", "Semicolon", 186],
    ["'\"", "Quote", 222],
    [",<", "Comma", 188],
    [".>", "Period", 190],
    ["/?", "Slash", 191],
    ["`~", "Backquote", 192],
  ].flatMap(([chars, code, vk]) => [...chars].map((ch) => [ch, [code, vk]])),
  ...[...")!@#$%^&*("].map((ch, i) => [ch, [`Digit${i}`, 48 + i]]),
]);

function describeKey(raw) {
  if ([...raw].length === 1 && raw !== " ") {
    if (/^[a-z]$/i.test(raw)) {
      return {
        key: raw,
        code: `Key${raw.toUpperCase()}`,
        vk: raw.toUpperCase().charCodeAt(0),
        text: raw,
      };
    }
    if (/^[0-9]$/.test(raw))
      return { key: raw, code: `Digit${raw}`, vk: raw.charCodeAt(0), text: raw };
    const p = PUNCT_CODES[raw];
    return { key: raw, code: p ? p[0] : "", vk: p ? p[1] : 0, text: raw };
  }
  const norm = raw.toLowerCase().replace(/[\s_-]/g, "");
  const named = NAMED_KEYS[KEY_ALIASES[norm] ?? norm] ?? NAMED_KEYS[raw];
  if (!named) throw new Error(`unknown key: ${JSON.stringify(raw)}`);
  return named;
}

async function sendKey(ev) {
  const k = describeKey(String(ev.key));
  const modifiers =
    (ev.ctrl ? MOD.ctrl : 0) | (ev.shift ? MOD.shift : 0) | (ev.meta ? MOD.meta : 0);
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers };
  const down =
    k.text && !ev.ctrl && !ev.meta
      ? { type: "keyDown", text: k.text, unmodifiedText: k.text }
      : { type: "rawKeyDown" };
  await cdp.send("Input.dispatchKeyEvent", { ...base, ...down }, session);
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" }, session);
}

async function sendInput(ev) {
  const x = Number(ev.x) * width;
  const y = Number(ev.y) * height;
  const mouse = (params) => cdp.send("Input.dispatchMouseEvent", { x, y, ...params }, session);
  if (ev.k === "pointer") {
    if (ev.type === "down") {
      pointerDown = true;
      await mouse({ type: "mousePressed", button: "left", buttons: 1, clickCount: 1 });
    } else if (ev.type === "up") {
      pointerDown = false;
      await mouse({ type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 });
    } else if (ev.type === "move") {
      await mouse({
        type: "mouseMoved",
        button: pointerDown ? "left" : "none",
        buttons: pointerDown ? 1 : 0,
      });
    } else {
      throw new Error(`unknown pointer type: ${ev.type}`);
    }
  } else if (ev.k === "wheel") {
    await mouse({ type: "mouseWheel", deltaX: 0, deltaY: Number(ev.dy) || 0 });
  } else if (ev.k === "key") {
    await sendKey(ev);
  } else {
    throw new Error(`unknown event kind: ${ev.k}`);
  }
}

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
      if (streaming) return reply(res, 200, { ok: true });
      for (const ev of body.events ?? []) await sendInput(ev);
      return reply(res, 200, { ok: true });
    case "POST /cast":
      await setCasting(Boolean(body.on));
      return reply(res, 200, { ok: true, casting });
    case "POST /list":
      if (typeof body.url !== "string") throw new Error("url is required");
      return reply(res, 200, { ok: true, ...(await listVideos(body.url, body.live === true)) });
    case "POST /twitch/list":
      if (body.query !== undefined && typeof body.query !== "string") {
        throw new Error("query must be a string");
      }
      return reply(res, 200, { ok: true, ...(await listTwitch(body.query?.trim())) });
    case "POST /gray":
      await setGray(typeof body.on === "boolean" ? body.on : !gray);
      return reply(res, 200, { ok: true, gray });
    case "POST /mute":
      await setMuted(typeof body.on === "boolean" ? body.on : !muted);
      return reply(res, 200, { ok: true, muted });
    case "POST /resize":
      if (typeof body.factor !== "number" || !(body.factor > 0)) {
        throw new Error("factor is required");
      }
      await ensurePanel();
      toPanel(`resize ${body.factor}`);
      return reply(res, 200, { ok: true });
    case "POST /toggle": {
      if (!streaming) return reply(res, 200, { ok: true, paused: await evaluate(TOGGLE_PLAY) });
      const state = await askPanel("toggle");
      if (state === null) throw new Error("the panel did not answer");
      return reply(res, 200, { ok: true, paused: state === "none" ? null : state === "paused" });
    }
    case "GET /state":
      return reply(res, 200, {
        ok: true,
        url: lastUrl,
        title: lastTitle,
        loggedIn: streaming ? streamLoggedIn : await isLoggedIn(),
        casting,
        streaming,
      });
    case "GET /accounts":
      return reply(res, 200, { ok: true, ...(await signedIn()) });
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
    // macOS cuts a socket path past 103 bytes silently; bind (inside listen) relative to runDir.
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
      await Promise.race([
        cdp.send("Browser.close").catch(() => {}),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
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
// The mod starts the helper with stdin at EOF, so only reparenting tells that the parent is gone.
const parentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== parentPid) shutdown(0);
}, 2000).unref();

async function main() {
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  await releaseProfile();
  startChrome();
  await attachPage();
  if (args.gray) await setGray(true);
  if (args.mute) await setMuted(true);
  await startServer();
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
