import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  HookStream,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  Register,
  Timer,
} from 'claude-code'

import type { Video } from '../types'

// The video shows in a floating macOS panel the helper owns, not in the
// terminal: this module lists videos as text and sends the helper commands.

const running = atom({ plugin: 'ctv', key: 'running' } as const, false)
const shown = atom({ plugin: 'ctv', key: 'shown' } as const, false)
const title = atom({ plugin: 'ctv', key: 'title' } as const, '')
const runDir = atom({ plugin: 'ctv', key: 'runDir' } as const, null)
// Black and white, kept for the session: a restarted helper starts gray too.
const gray = atom({ plugin: 'ctv', key: 'gray' } as const, false)
// No sound, kept for the session the same way.
const muted = atom({ plugin: 'ctv', key: 'muted' } as const, false)

type Child = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

type Site = 'YouTube' | 'Twitch'

type HelperLine =
  | { t: 'ready' }
  | { t: 'nav'; url: string; title: string }
  | { t: 'error'; message: string }

// The running child. A reload kills the child and starts these over, so
// session.start resets the state that describes them.
let child: Child | null = null
// Settles true when the running child's control socket answers, false when
// the child ended first.
let ready: Promise<boolean> | null = null
// The last list shown and its site, so `/ctv <number>` names one; and whether
// a video is loaded in the view.
let videos: Video[] = []
let listSite: Site = 'YouTube'
let hasVideo = false
const SIGNED_OUT = 'YouTube is signed out. Run /ctv login to sign in once.'
const TWITCH_SIGNED_OUT = 'Twitch is signed out. Run /ctv login twitch to sign in once.'

const HOME_URL = 'https://www.youtube.com/'

// A stuck helper must not hold a command until its hook runs out of time.
const CONTROL_TIMEOUT_MS = 5000
// Calls that run on after the hook returned wait longer: a list waits up to
// 15 s for the page, a navigation for the network, and the first cast builds
// the Swift panel (swiftc, up to 180 s).
const PAGE_TIMEOUT_MS = 60_000
const CAST_TIMEOUT_MS = 200_000

const searchUrl = (text: string) =>
  `https://www.youtube.com/results?search_query=${encodeURIComponent(text)}`

const siteOf = (url: string): Site => (/^https?:\/\/([^/]+\.)?twitch\.tv\//i.test(url) ? 'Twitch' : 'YouTube')

const randomHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

async function control(
  $: EngineInterface,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = CONTROL_TIMEOUT_MS,
) {
  const dir = await read($, runDir)
  if (dir === null) {
    return undefined
  }
  const init = {
    method,
    socketPath: `${dir}/control.sock`,
    headers: { 'content-type': 'application/json' },
  }
  // `$.http.fetch` takes no timeout or signal: race it against a timer.
  let timer: Timer | undefined
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = $.clock.after(timeoutMs, () => resolve('timeout'))
  })
  try {
    const response = await Promise.race([
      $.http.fetch(
        `http://ctv${path}`,
        body === undefined ? init : { ...init, body: JSON.stringify(body) },
      ),
      timedOut,
    ])
    if (response === 'timeout') {
      $.ui.log(`ctv: ${path} timed out after ${timeoutMs} ms`, { to: 'debug' })

      return undefined
    }
    if (!response.ok) {
      // The helper answers `{ ok: false, error }`; else name the status.
      let message = `HTTP ${response.status}`
      try {
        const parsed = JSON.parse(response.text) as { error?: unknown }
        if (typeof parsed.error === 'string' && parsed.error !== '') {
          message = parsed.error
        }
      } catch {
        // Not JSON: keep the status.
      }
      $.ui.toast(`ctv: ${message}`)

      return undefined
    }

    return response
  } catch (error) {
    $.ui.log(`ctv: ${path} failed: ${String(error)}`, { to: 'debug' })

    return undefined
  } finally {
    timer?.cancel()
  }
}

async function onLine($: EngineInterface, line: string, markReady: (ok: boolean) => void) {
  let message: HelperLine
  try {
    message = JSON.parse(line) as HelperLine
  } catch {
    $.ui.log(`ctv: helper wrote ${line}`, { to: 'debug' })

    return
  }

  if (message.t === 'nav') {
    const pageTitle = message.title
    await update($, title, () => pageTitle)
    $.ui.status(pageTitle)
  } else if (message.t === 'ready') {
    markReady(true)
  } else if (message.t === 'error') {
    $.ui.toast(`ctv: ${message.message}`)
  }
}

async function reset($: EngineInterface) {
  hasVideo = false
  await update($, running, () => false)
  await update($, shown, () => false)
  await update($, title, () => '')
  $.ui.status(undefined)
}

async function pump($: EngineInterface, stream: Child, markReady: (ok: boolean) => void) {
  let buffer = ''
  try {
    for await (const { stream: pipe, text } of stream) {
      if (pipe === 'stderr') {
        $.ui.log(`ctv: ${text}`, { to: 'debug' })
        continue
      }
      buffer += text
      let end = buffer.indexOf('\n')
      while (end !== -1) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (line !== '') {
          await onLine($, line, markReady)
        }
        end = buffer.indexOf('\n')
      }
    }
  } catch (error) {
    $.ui.log(`ctv: helper failed: ${String(error)}`, { to: 'debug' })
  }

  markReady(false)
  // Still the current child: it ended by itself, not by /ctv off or login.
  if (child === stream) {
    child = null
    await reset($)
    $.ui.toast('YouTube stopped.')
  }
}

async function stopHelper($: EngineInterface) {
  const old = child
  child = null
  if (old !== null) {
    await control($, 'POST', '/quit')
    void old.return({ code: null, signal: null }).catch(() => undefined)
  }
}

// Starts the helper with no view: lists need none, and `play` shows it.
async function startHelper($: EngineInterface) {
  const dir = `/tmp/ctv-${randomHex()}`
  await update($, runDir, () => dir)
  await update($, running, () => true)
  await update($, shown, () => false)
  await update($, title, () => '')

  const stream = $.process.spawn({
    argv: [
      'node',
      `${$.plugin.root}/helper/view.mjs`,
      '--run-dir',
      dir,
      ...((await read($, gray)) ? ['--gray'] : []),
      ...((await read($, muted)) ? ['--mute'] : []),
    ],
  })
  child = stream
  let markReady: (ok: boolean) => void = () => undefined
  ready = new Promise<boolean>(resolve => {
    markReady = resolve
  })
  // The loop is the child's life: it runs on after this hook returns.
  void pump($, stream, markReady)
}

async function ensureHelper($: EngineInterface) {
  if (child === null) {
    await startHelper($)
  }

  return ready !== null && (await ready)
}

// The helper shows or hides its floating panel with the frames.
async function show($: EngineInterface) {
  await update($, shown, () => true)
  await control($, 'POST', '/cast', { on: true }, CAST_TIMEOUT_MS)
}

async function hide($: EngineInterface) {
  await update($, shown, () => false)
  await control($, 'POST', '/cast', { on: false }, CAST_TIMEOUT_MS)
}

// Both run on after the command's hook returned: a hook has ten seconds, and
// a cold start plus a page load may take longer.
type ListRequest = {
  site: Site
  path: '/list' | '/twitch/list'
  body: { url: string } | { query?: string }
  heading: string
  // Logged when the list is empty.
  empty: string
  // Toasted when the helper reports no sign-in; undefined when none is needed.
  signedOut: string | undefined
}

async function listVideos($: EngineInterface, request: ListRequest) {
  if (!(await ensureHelper($))) {
    return
  }
  const response = await control($, 'POST', request.path, request.body, PAGE_TIMEOUT_MS)
  let found: { items?: Video[]; loggedIn?: boolean } = {}
  try {
    found = JSON.parse(response?.text ?? '{}') as typeof found
  } catch {
    found = {}
  }
  if (found.loggedIn === false && request.signedOut !== undefined) {
    $.ui.toast(request.signedOut)
  }
  videos = found.items ?? []
  listSite = request.site
  if (videos.length === 0) {
    $.ui.log(request.empty)

    return
  }
  $.ui.log(`${request.site} · ${request.heading} · /ctv <number> plays one`)
  videos.forEach((video, index) => {
    const by = video.channel === '' ? '' : ` — ${video.channel}`
    const length = video.length === '' ? '' : ` (${video.length})`
    $.ui.log(`${String(index + 1).padStart(2)}. ${video.title}${by}${length}  ${video.url}`)
  })
}

const youtubeList = (url: string, heading: string): ListRequest => ({
  site: 'YouTube',
  path: '/list',
  body: { url },
  heading,
  empty: `YouTube: nothing found for ${heading}.`,
  signedOut: SIGNED_OUT,
})

const twitchList = (query: string): ListRequest =>
  query === ''
    ? {
        site: 'Twitch',
        path: '/twitch/list',
        body: {},
        heading: 'following',
        empty: 'Twitch: nobody you follow is live.',
        signedOut: TWITCH_SIGNED_OUT,
      }
    : {
        site: 'Twitch',
        path: '/twitch/list',
        body: { query },
        heading: `"${query}"`,
        empty: `Twitch: nothing found for "${query}".`,
        signedOut: undefined,
      }

async function play($: EngineInterface, url: string) {
  if (!(await ensureHelper($))) {
    return
  }
  if ((await control($, 'POST', '/navigate', { url }, PAGE_TIMEOUT_MS)) === undefined) {
    return
  }
  hasVideo = true
  await show($)
}

const background = ($: EngineInterface, work: Promise<void>) => {
  void work.catch((error: unknown) => {
    $.ui.log(`ctv: ${String(error)}`, { to: 'debug' })
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ctv',
      description: 'List YouTube or Twitch videos and play one in a small floating window',
      argumentHint:
        '[home | search | number | url | twitch [search] | pause | mute | unmute | bigger | smaller | gray | off | login [twitch]]',
    })
    // What was stored before a reload describes a child that is gone.
    await reset($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await stopHelper($)

    return next(e)
  })

  on('command.run', { command: 'ctv' }, async ($, e) => {
    const args = e.args.trim()

    if (args === 'off') {
      await stopHelper($)
      await reset($)

      return { text: 'YouTube stopped.' }
    }

    if (args === 'login') {
      await stopHelper($)
      await reset($)
      await $.process.run(['node', `${$.plugin.root}/helper/view.mjs`, '--login'])

      return {
        text: 'A Chrome window opened. Sign in to Google there, then come back and run /ctv.',
      }
    }

    if (args === 'login twitch') {
      await stopHelper($)
      await reset($)
      await $.process.run(['node', `${$.plugin.root}/helper/view.mjs`, '--login-twitch'])

      return {
        text: 'A Chrome window opened. Sign in to Twitch there, then come back and run /ctv twitch.',
      }
    }

    if (args === 'gray') {
      const isGray = !(await read($, gray))
      await update($, gray, () => isGray)
      if (child !== null) {
        await control($, 'POST', '/gray', { on: isGray })
      }

      return { text: `YouTube: black and white ${isGray ? 'on' : 'off'}.` }
    }

    if (args === 'mute' || args === 'unmute') {
      const isMuted = args === 'mute'
      await update($, muted, () => isMuted)
      if (child !== null) {
        await control($, 'POST', '/mute', { on: isMuted })
      }

      return { text: `YouTube: sound ${isMuted ? 'off' : 'on'}.` }
    }

    if (args === 'bigger' || args === 'smaller') {
      if (child === null) {
        return { text: 'YouTube: nothing is playing.' }
      }
      await control($, 'POST', '/resize', { factor: args === 'bigger' ? 1.25 : 0.8 })

      return { text: `YouTube window ${args}.` }
    }

    if (args === 'pause') {
      if (!hasVideo) {
        return { text: 'YouTube: nothing is playing.' }
      }
      await control($, 'POST', '/toggle')

      return { text: 'YouTube: play/pause.' }
    }

    if (/^\d+$/.test(args)) {
      const video = videos[Number(args) - 1]
      if (video === undefined) {
        return { text: `${listSite}: no item ${args} in the last list.` }
      }
      background($, play($, video.url))

      return { text: `${listSite}: playing ${video.title}` }
    }

    if (/^https?:\/\//i.test(args)) {
      background($, play($, args))

      return { text: `${siteOf(args)}: opening ${args}` }
    }

    if (args === 'twitch' || args.startsWith('twitch ')) {
      const query = args.slice('twitch'.length).trim()
      background($, listVideos($, twitchList(query)))

      return {
        text: query === '' ? 'Twitch: loading who you follow…' : `Twitch: searching "${query}"…`,
      }
    }

    if (args === 'home') {
      background($, listVideos($, youtubeList(HOME_URL, 'home')))

      return { text: 'YouTube: loading your home feed…' }
    }

    if (args !== '') {
      background($, listVideos($, youtubeList(searchUrl(args), `"${args}"`)))

      return { text: `YouTube: searching "${args}"…` }
    }

    // No argument: with a video loaded, hide or show it; else list the home feed.
    if (hasVideo && child !== null) {
      if (await read($, shown)) {
        await hide($)

        return { text: 'YouTube window hidden. Sound keeps playing.' }
      }
      await show($)

      return { text: 'YouTube window shown.' }
    }
    background($, listVideos($, youtubeList(HOME_URL, 'home')))

    return { text: 'YouTube: loading your home feed…' }
  })
}
