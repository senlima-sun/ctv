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
// `ctv` when the list held both sites.
let listSite: Site | 'ctv' = 'YouTube'
let hasVideo = false
// The site of the video loaded in the view, named in messages; null when none.
let playingSite: Site | null = null
const label = () => playingSite ?? 'ctv'
const SIGNED_OUT = 'YouTube is signed out. Run /ctv login yt to sign in once.'
const TWITCH_SIGNED_OUT = 'Twitch is signed out. Run /ctv login th to sign in once.'

// The names `/ctv` takes for a site, and the labels a person picks from.
const SITES = new Map<string, Site>([
  ['yt', 'YouTube'],
  ['youtube', 'YouTube'],
  ['th', 'Twitch'],
  ['twitch', 'Twitch'],
])
const SITE_LABELS: readonly Site[] = ['YouTube', 'Twitch']

const HOME_URL = 'https://www.youtube.com/'
const SUBSCRIPTIONS_URL = 'https://www.youtube.com/feed/subscriptions'

// A stuck helper must not hold a command until its hook runs out of time.
const CONTROL_TIMEOUT_MS = 5000
// Calls that run on after the hook returned wait longer: a list waits up to
// 15 s for the page, a navigation for the network, and the first cast builds
// the Swift panel (swiftc, up to 180 s).
const PAGE_TIMEOUT_MS = 60_000
const CAST_TIMEOUT_MS = 200_000

const searchUrl = (text: string) =>
  `https://www.youtube.com/results?search_query=${encodeURIComponent(text)}`

const siteOf = (url: string): Site =>
  /^https?:\/\/([^/]+\.)?twitch\.tv\//i.test(url) ? 'Twitch' : 'YouTube'

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
  playingSite = null
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
    $.ui.toast('ctv stopped.')
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
  body: { url: string; live?: true } | { query?: string }
  heading: string
  // Logged when the list is empty.
  empty: string
  // Toasted when the helper reports no sign-in; undefined when none is needed.
  signedOut: string | undefined
}

// The items of one list, or null when the helper did not start.
async function fetchList($: EngineInterface, request: ListRequest) {
  if (!(await ensureHelper($))) {
    return null
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

  return found.items ?? []
}

const logVideo = ($: EngineInterface, video: Video, index: number, tag = '') => {
  const by = video.channel === '' ? '' : ` — ${video.channel}`
  const length = video.length === '' ? '' : ` (${video.length})`
  $.ui.log(`${String(index + 1).padStart(2)}. ${tag}${video.title}${by}${length}  ${video.url}`)
}

async function listVideos($: EngineInterface, request: ListRequest) {
  const items = await fetchList($, request)
  if (items === null) {
    return
  }
  videos = items
  listSite = request.site
  if (videos.length === 0) {
    $.ui.log(request.empty)

    return
  }
  $.ui.log(`${request.site} · ${request.heading} · /ctv <number> plays one`)
  videos.forEach((video, index) => logVideo($, video, index))
}

const youtubeList = (url: string, heading: string, live?: true): ListRequest => ({
  site: 'YouTube',
  path: '/list',
  body: live === undefined ? { url } : { url, live },
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

// What a site lists: its own start (YouTube home, Twitch follow), what you
// follow, who you follow that is live now, or a search.
type Want = { verb: 'start' | 'follow' | 'streaming' } | { verb: 'search'; query: string }

function listFor(site: Site, want: Want): { request: ListRequest; loading: string } {
  if (site === 'Twitch') {
    const query = want.verb === 'search' ? want.query : ''

    return {
      request: twitchList(query),
      loading: query === '' ? 'Twitch: loading who you follow…' : `Twitch: searching "${query}"…`,
    }
  }
  if (want.verb === 'search') {
    return {
      request: youtubeList(searchUrl(want.query), `"${want.query}"`),
      loading: `YouTube: searching "${want.query}"…`,
    }
  }
  if (want.verb === 'streaming') {
    return {
      request: youtubeList(SUBSCRIPTIONS_URL, 'live now', true),
      loading: 'YouTube: loading who you subscribe to that is live…',
    }
  }
  if (want.verb === 'follow') {
    return {
      request: youtubeList(SUBSCRIPTIONS_URL, 'subscriptions'),
      loading: 'YouTube: loading your subscriptions…',
    }
  }

  return { request: youtubeList(HOME_URL, 'home'), loading: 'YouTube: loading your home feed…' }
}

// Resolves to the site picked, or null when the person dismissed the question
// (or nobody can be asked) or typed something that is not a site.
async function askSite($: EngineInterface, question: string) {
  let answer: string
  try {
    answer = await $.ui.ask(question, { options: SITE_LABELS, header: 'ctv' })
  } catch (error) {
    $.ui.log(`ctv: "${question}" not answered: ${String(error)}`, { to: 'debug' })

    return null
  }
  const site = SITE_LABELS.find(one => one === answer)
  if (site === undefined) {
    $.ui.log('ctv: pick YouTube or Twitch.')

    return null
  }

  return site
}

// The sign-in state of both sites, or null when the helper did not start.
async function readAccounts($: EngineInterface) {
  if (!(await ensureHelper($))) {
    return null
  }
  const response = await control($, 'GET', '/accounts')
  let accounts: { youtube?: boolean; twitch?: boolean } = {}
  try {
    accounts = JSON.parse(response?.text ?? '{}') as typeof accounts
  } catch {
    accounts = {}
  }

  return { youtube: accounts.youtube === true, twitch: accounts.twitch === true }
}

// The one site signed in, else the site the person picks.
async function resolveSite($: EngineInterface) {
  const accounts = await readAccounts($)
  if (accounts === null) {
    return null
  }
  if (accounts.youtube === true && accounts.twitch !== true) {
    return 'YouTube'
  }
  if (accounts.twitch === true && accounts.youtube !== true) {
    return 'Twitch'
  }

  return askSite($, 'Which site?')
}

async function listOn($: EngineInterface, site: Site | null, want: Want) {
  const chosen = site ?? (await resolveSite($))
  if (chosen === null) {
    return
  }
  const { request, loading } = listFor(chosen, want)
  $.ui.log(loading)
  await listVideos($, request)
}

// Who is live now on every site signed in, in one list numbered across both.
async function listStreaming($: EngineInterface) {
  const accounts = await readAccounts($)
  if (accounts === null) {
    return
  }
  if (!accounts.youtube && !accounts.twitch) {
    $.ui.toast('ctv: sign in first: /ctv login yt or /ctv login th')

    return
  }
  $.ui.log('ctv: loading who is live now…')
  const youtube = accounts.youtube
    ? await fetchList($, listFor('YouTube', { verb: 'streaming' }).request)
    : []
  const twitch = accounts.twitch
    ? await fetchList($, listFor('Twitch', { verb: 'streaming' }).request)
    : []
  const tagged = [
    ...(youtube ?? []).map(video => ({ video, tag: '[YT] ' })),
    ...(twitch ?? []).map(video => ({ video, tag: '[TH] ' })),
  ]
  videos = tagged.map(one => one.video)
  listSite = 'ctv'
  if (videos.length === 0) {
    $.ui.log('ctv: nobody you follow is live.')

    return
  }
  $.ui.log('Live now · /ctv <number> plays one')
  tagged.forEach(({ video, tag }, index) => logVideo($, video, index, tag))
}

async function login($: EngineInterface, site: Site) {
  await stopHelper($)
  await reset($)
  if (site === 'YouTube') {
    await $.process.run(['node', `${$.plugin.root}/helper/view.mjs`, '--login'])
    $.ui.log('A Chrome window opened. Sign in to Google there, then come back and run /ctv yt.')

    return
  }
  await $.process.run(['node', `${$.plugin.root}/helper/view.mjs`, '--login-twitch'])
  $.ui.log('A Chrome window opened. Sign in to Twitch there, then come back and run /ctv th.')
}

async function askLogin($: EngineInterface) {
  const site = await askSite($, 'Sign in to which site?')
  if (site !== null) {
    await login($, site)
  }
}

async function play($: EngineInterface, url: string) {
  if (!(await ensureHelper($))) {
    return
  }
  if ((await control($, 'POST', '/navigate', { url }, PAGE_TIMEOUT_MS)) === undefined) {
    return
  }
  hasVideo = true
  playingSite = siteOf(url)
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
        '[yt | th] [search <text> | follow | streaming | text] | number | url | pause | mute | unmute | bigger | smaller | gray | off | login [yt | th]',
    })
    // What was stored before a reload describes a child that is gone.
    await reset($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await stopHelper($)

    return next(e)
  })

  // Every reply is a `$.ui.log` row, which the model does not read; the hook
  // answers with no text, so nothing of `/ctv` goes in a request.
  on('command.run', { command: 'ctv' }, async ($, e) => {
    const args = e.args.trim()

    if (args === 'off') {
      await stopHelper($)
      await reset($)
      $.ui.log('ctv stopped.')

      return {}
    }

    if (args === 'login') {
      // A person may answer slowly, past the hook's ten seconds.
      background($, askLogin($))

      return {}
    }

    const loginSite = /^login\s+(\S+)$/.exec(args)?.[1]
    if (loginSite !== undefined) {
      const site = SITES.get(loginSite.toLowerCase())
      if (site === undefined) {
        $.ui.log('ctv: pick YouTube or Twitch.')

        return {}
      }
      await login($, site)

      return {}
    }

    if (args === 'gray') {
      const isGray = !(await read($, gray))
      await update($, gray, () => isGray)
      if (child !== null) {
        await control($, 'POST', '/gray', { on: isGray })
      }
      $.ui.log(`${label()}: black and white ${isGray ? 'on' : 'off'}.`)

      return {}
    }

    if (args === 'mute' || args === 'unmute') {
      const isMuted = args === 'mute'
      await update($, muted, () => isMuted)
      if (child !== null) {
        await control($, 'POST', '/mute', { on: isMuted })
      }
      $.ui.log(`${label()}: sound ${isMuted ? 'off' : 'on'}.`)

      return {}
    }

    if (args === 'bigger' || args === 'smaller') {
      if (child === null) {
        $.ui.log('ctv: nothing is playing.')

        return {}
      }
      await control($, 'POST', '/resize', { factor: args === 'bigger' ? 1.25 : 0.8 })
      $.ui.log(`${label()} window ${args}.`)

      return {}
    }

    if (args === 'pause') {
      if (!hasVideo) {
        $.ui.log('ctv: nothing is playing.')

        return {}
      }
      await control($, 'POST', '/toggle')
      $.ui.log(`${label()}: play/pause.`)

      return {}
    }

    if (/^\d+$/.test(args)) {
      const video = videos[Number(args) - 1]
      if (video === undefined) {
        $.ui.log(`${listSite}: no item ${args} in the last list.`)

        return {}
      }
      background($, play($, video.url))
      $.ui.log(`${siteOf(video.url)}: playing ${video.title}`)

      return {}
    }

    if (/^https?:\/\//i.test(args)) {
      background($, play($, args))
      $.ui.log(`${siteOf(args)}: opening ${args}`)

      return {}
    }

    // `[site] [search <text> | follow | text]`: a site left out is the one
    // signed in, or the one the person picks.
    const first = args.split(/\s/, 1)[0] ?? ''
    const site = SITES.get(first.toLowerCase()) ?? null
    const rest = site === null ? args : args.slice(first.length).trim()

    if (rest === '') {
      // Bare `/ctv` with a video loaded: hide or show it.
      if (site === null && hasVideo && child !== null) {
        if (await read($, shown)) {
          await hide($)
          $.ui.log(`${label()} window hidden. Sound keeps playing.`)

          return {}
        }
        await show($)
        $.ui.log(`${label()} window shown.`)

        return {}
      }
      background($, listOn($, site, { verb: 'start' }))

      return {}
    }

    if (rest === 'follow') {
      background($, listOn($, site, { verb: 'follow' }))

      return {}
    }

    if (rest === 'streaming') {
      // No site named: no question, every site signed in.
      background($, site === null ? listStreaming($) : listOn($, site, { verb: 'streaming' }))

      return {}
    }

    const search = /^search(?:\s+(.*))?$/s.exec(rest)
    const query = search === null ? rest : (search[1] ?? '').trim()
    if (query === '') {
      $.ui.log('ctv: search what?')

      return {}
    }
    background($, listOn($, site, { verb: 'search', query }))

    return {}
  })
}
