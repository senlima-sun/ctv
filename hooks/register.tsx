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

const running = atom({ plugin: 'ctv', key: 'running' } as const, false)
const shown = atom({ plugin: 'ctv', key: 'shown' } as const, false)
const title = atom({ plugin: 'ctv', key: 'title' } as const, '')
const runDir = atom({ plugin: 'ctv', key: 'runDir' } as const, null)
// Kept for the session, so a restarted helper starts gray or muted too.
const gray = atom({ plugin: 'ctv', key: 'gray' } as const, false)
const muted = atom({ plugin: 'ctv', key: 'muted' } as const, false)

type Child = HookStream<ProcessSpawnChunk, ProcessSpawnResult>
type Site = 'YouTube' | 'Twitch'
type HelperLine =
  | { t: 'ready' }
  | { t: 'nav'; url: string; title: string }
  | { t: 'error'; message: string }
type Row = { video: Video; tag?: string }

// A reload kills the child and starts these over; session.start resets the atoms.
let child: Child | null = null
let ready: Promise<boolean> | null = null
let videos: Video[] = []
let listSite: Site | 'ctv' = 'YouTube'
let hasVideo = false
let playingSite: Site | null = null
const label = () => playingSite ?? 'ctv'

const SITES = new Map<string, Site>([
  ['yt', 'YouTube'],
  ['youtube', 'YouTube'],
  ['th', 'Twitch'],
  ['twitch', 'Twitch'],
])
const SITE_LABELS: readonly Site[] = ['YouTube', 'Twitch']
const SHORT = { YouTube: 'yt', Twitch: 'th' } as const
const signedOut = (site: Site) =>
  `${site} is signed out. Run /ctv login ${SHORT[site]} to sign in once.`
const PICK = 'ctv: pick YouTube or Twitch.'
const NOTHING = 'ctv: nothing is playing.'

const HOME_URL = 'https://www.youtube.com/'
const SUBSCRIPTIONS_URL = 'https://www.youtube.com/feed/subscriptions'

// A stuck helper must not hold a command until its hook runs out of time.
const CONTROL_TIMEOUT_MS = 5000
// Background calls wait longer: a list waits for the page, the first cast runs swiftc (≤ 180 s).
const PAGE_TIMEOUT_MS = 60_000
const CAST_TIMEOUT_MS = 200_000

const helperPath = ($: EngineInterface) => `${$.plugin.root}/helper/view.mjs`

const searchUrl = (text: string) =>
  `https://www.youtube.com/results?search_query=${encodeURIComponent(text)}`

const siteOf = (url: string): Site =>
  /^https?:\/\/([^/]+\.)?twitch\.tv\//i.test(url) ? 'Twitch' : 'YouTube'

const randomHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

function parseJson<T extends object>(text: string | undefined): Partial<T> {
  try {
    return (JSON.parse(text ?? '{}') as Partial<T> | null) ?? {}
  } catch {
    return {}
  }
}

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
      const { error } = parseJson<{ error: unknown }>(response.text)
      $.ui.toast(
        `ctv: ${typeof error === 'string' && error !== '' ? error : `HTTP ${response.status}`}`,
      )

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
  // Still current: the child ended by itself, not by /ctv off or login.
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

async function startHelper($: EngineInterface) {
  const dir = `/tmp/ctv-${randomHex()}`
  await update($, runDir, () => dir)
  await update($, running, () => true)
  await update($, shown, () => false)
  await update($, title, () => '')
  const stream = $.process.spawn({
    argv: [
      'node',
      helperPath($),
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
  void pump($, stream, markReady)
}

async function ensureHelper($: EngineInterface) {
  if (child === null) {
    await startHelper($)
  }

  return ready !== null && (await ready)
}

async function cast($: EngineInterface, on: boolean) {
  await update($, shown, () => on)
  await control($, 'POST', '/cast', { on }, CAST_TIMEOUT_MS)
}

type ListRequest = {
  site: Site
  path: '/list' | '/twitch/list'
  body: { url: string; live?: true } | { query?: string }
  heading: string
  loading: string
  empty: string
  signedOut: string | undefined
}

type Verb = 'start' | 'follow' | 'streaming' | 'search'
type Feed = { url: string; heading: string; loading: string; live?: true }

const YOUTUBE_FEEDS: Record<Exclude<Verb, 'search'>, Feed> = {
  start: { url: HOME_URL, heading: 'home', loading: 'YouTube: loading your home feed…' },
  follow: {
    url: SUBSCRIPTIONS_URL,
    heading: 'subscriptions',
    loading: 'YouTube: loading your subscriptions…',
  },
  streaming: {
    url: SUBSCRIPTIONS_URL,
    heading: 'live now',
    loading: 'YouTube: loading who you subscribe to that is live…',
    live: true,
  },
}

const youtubeList = ({ url, heading, loading, live }: Feed): ListRequest => ({
  site: 'YouTube',
  path: '/list',
  body: live === undefined ? { url } : { url, live },
  heading,
  loading,
  empty: `YouTube: nothing found for ${heading}.`,
  signedOut: signedOut('YouTube'),
})

// Twitch lists who you follow that is live for every verb but a search.
function listFor(site: Site, verb: Verb, query = ''): ListRequest {
  if (site === 'Twitch') {
    const base = { site, path: '/twitch/list' } as const

    return query === ''
      ? {
          ...base,
          body: {},
          heading: 'following',
          loading: 'Twitch: loading who you follow…',
          empty: 'Twitch: nobody you follow is live.',
          signedOut: signedOut('Twitch'),
        }
      : {
          ...base,
          body: { query },
          heading: `"${query}"`,
          loading: `Twitch: searching "${query}"…`,
          empty: `Twitch: nothing found for "${query}".`,
          signedOut: undefined,
        }
  }

  return verb === 'search'
    ? youtubeList({
        url: searchUrl(query),
        heading: `"${query}"`,
        loading: `YouTube: searching "${query}"…`,
      })
    : youtubeList(YOUTUBE_FEEDS[verb])
}

async function fetchList($: EngineInterface, request: ListRequest) {
  if (!(await ensureHelper($))) {
    return null
  }
  const response = await control($, 'POST', request.path, request.body, PAGE_TIMEOUT_MS)
  const found = parseJson<{ items: Video[]; loggedIn: boolean }>(response?.text)
  if (found.loggedIn === false && request.signedOut !== undefined) {
    $.ui.toast(request.signedOut)
  }

  return found.items ?? []
}

function showList(
  $: EngineInterface,
  site: Site | 'ctv',
  rows: Row[],
  empty: string,
  heading: string,
) {
  videos = rows.map(row => row.video)
  listSite = site
  if (rows.length === 0) {
    $.ui.log(empty)

    return
  }
  $.ui.log(`${heading} · /ctv <number> plays one`)
  rows.forEach(({ video, tag = '' }, index) => {
    const by = video.channel === '' ? '' : ` — ${video.channel}`
    const length = video.length === '' ? '' : ` (${video.length})`
    $.ui.log(`${String(index + 1).padStart(2)}. ${tag}${video.title}${by}${length}  ${video.url}`)
  })
}

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
    $.ui.log(PICK)

    return null
  }

  return site
}

async function readAccounts($: EngineInterface) {
  if (!(await ensureHelper($))) {
    return null
  }
  const accounts = parseJson<{ youtube: boolean; twitch: boolean }>(
    (await control($, 'GET', '/accounts'))?.text,
  )

  return { youtube: accounts.youtube === true, twitch: accounts.twitch === true }
}

async function resolveSite($: EngineInterface) {
  const accounts = await readAccounts($)
  if (accounts === null) {
    return null
  }
  if (accounts.youtube !== accounts.twitch) {
    return accounts.youtube ? 'YouTube' : 'Twitch'
  }

  return askSite($, 'Which site?')
}

async function listOn($: EngineInterface, site: Site | null, verb: Verb, query?: string) {
  const chosen = site ?? (await resolveSite($))
  if (chosen === null) {
    return
  }
  const request = listFor(chosen, verb, query)
  $.ui.log(request.loading)
  const items = await fetchList($, request)
  if (items !== null) {
    showList(
      $,
      chosen,
      items.map(video => ({ video })),
      request.empty,
      `${chosen} · ${request.heading}`,
    )
  }
}

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
  const live = async (site: Site, signedIn: boolean): Promise<Row[]> =>
    signedIn
      ? ((await fetchList($, listFor(site, 'streaming'))) ?? []).map(video => ({
          video,
          tag: `[${SHORT[site].toUpperCase()}] `,
        }))
      : []
  const rows = [
    ...(await live('YouTube', accounts.youtube)),
    ...(await live('Twitch', accounts.twitch)),
  ]
  showList($, 'ctv', rows, 'ctv: nobody you follow is live.', 'Live now')
}

async function login($: EngineInterface, site: Site) {
  await stopHelper($)
  await reset($)
  const [flag, account] = site === 'YouTube' ? ['--login', 'Google'] : ['--login-twitch', 'Twitch']
  await $.process.run(['node', helperPath($), flag])
  $.ui.log(
    `A Chrome window opened. Sign in to ${account} there, then come back and run /ctv ${SHORT[site]}.`,
  )
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
  await cast($, true)
}

// A hook has ten seconds; a cold start, a page load or a person answering may take longer.
const background = ($: EngineInterface, work: Promise<unknown>) => {
  void work.catch((error: unknown) => {
    $.ui.log(`ctv: ${String(error)}`, { to: 'debug' })
  })
}

const LIST_VERBS = new Map<string, Verb>([
  ['', 'start'],
  ['follow', 'follow'],
  ['streaming', 'streaming'],
])

async function runCtv($: EngineInterface, args: string) {
  if (args === 'off') {
    await stopHelper($)
    await reset($)
    $.ui.log('ctv stopped.')

    return
  }

  const loginMatch = /^login(?:\s+(\S+))?$/.exec(args)
  if (loginMatch !== null) {
    const named = loginMatch[1]
    if (named === undefined) {
      const asked = askSite($, 'Sign in to which site?')
      background(
        $,
        asked.then(site => (site === null ? undefined : login($, site))),
      )

      return
    }
    const site = SITES.get(named.toLowerCase())
    if (site === undefined) {
      $.ui.log(PICK)

      return
    }
    await login($, site)

    return
  }

  if (args === 'gray') {
    const on = !(await read($, gray))
    await update($, gray, () => on)
    if (child !== null) {
      await control($, 'POST', '/gray', { on })
    }
    $.ui.log(`${label()}: black and white ${on ? 'on' : 'off'}.`)

    return
  }

  if (args === 'mute' || args === 'unmute') {
    const on = args === 'mute'
    await update($, muted, () => on)
    if (child !== null) {
      await control($, 'POST', '/mute', { on })
    }
    $.ui.log(`${label()}: sound ${on ? 'off' : 'on'}.`)

    return
  }

  if (args === 'bigger' || args === 'smaller') {
    if (child === null) {
      $.ui.log(NOTHING)

      return
    }
    await control($, 'POST', '/resize', { factor: args === 'bigger' ? 1.25 : 0.8 })
    $.ui.log(`${label()} window ${args}.`)

    return
  }

  if (args === 'pause') {
    if (!hasVideo) {
      $.ui.log(NOTHING)

      return
    }
    await control($, 'POST', '/toggle')
    $.ui.log(`${label()}: play/pause.`)

    return
  }

  if (/^\d+$/.test(args)) {
    const video = videos[Number(args) - 1]
    if (video === undefined) {
      $.ui.log(`${listSite}: no item ${args} in the last list.`)

      return
    }
    background($, play($, video.url))
    $.ui.log(`${siteOf(video.url)}: playing ${video.title}`)

    return
  }

  if (/^https?:\/\//i.test(args)) {
    background($, play($, args))
    $.ui.log(`${siteOf(args)}: opening ${args}`)

    return
  }

  const first = args.split(/\s/, 1)[0] ?? ''
  const site = SITES.get(first.toLowerCase()) ?? null
  const rest = site === null ? args : args.slice(first.length).trim()

  if (rest === '' && site === null && hasVideo && child !== null) {
    const on = !(await read($, shown))
    await cast($, on)
    $.ui.log(on ? `${label()} window shown.` : `${label()} window hidden. Sound keeps playing.`)

    return
  }

  const verb = LIST_VERBS.get(rest)
  if (verb !== undefined) {
    // `streaming` with no site asks nothing and lists every site signed in.
    background($, verb === 'streaming' && site === null ? listStreaming($) : listOn($, site, verb))

    return
  }

  const search = /^search(?:\s+(.*))?$/s.exec(rest)
  const query = search === null ? rest : (search[1] ?? '').trim()
  if (query === '') {
    $.ui.log('ctv: search what?')

    return
  }
  background($, listOn($, site, 'search', query))
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

  // Replies go to $.ui.log, which the model does not read; returned text would reach it.
  on('command.run', { command: 'ctv' }, async ($, e) => {
    await runCtv($, e.args.trim())

    return {}
  })
}
