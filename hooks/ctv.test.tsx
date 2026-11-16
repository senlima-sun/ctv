import { expect, test } from 'claude-code/testing'

const RUN = {
  command: 'ctv',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 200 },
} as const

type Fetch = { url: string; init?: { method?: string; body?: unknown; socketPath?: string } }

test('/ctv lists, plays by number, hides, lists home and pauses', async ($, on) => {
  const fetches: Fetch[] = []
  const spawns: (readonly string[])[] = []
  const logs: string[] = []
  // One promise per fetch the test waits for, settled when that path is asked.
  const waiters = new Map<string, () => void>()
  const asked = (path: string, count: number) =>
    new Promise<void>(resolve => {
      waiters.set(`${path}#${count}`, resolve)
    })
  const firstList = asked('/list', 1)
  const castOn = asked('/cast', 1)
  const secondList = asked('/list', 2)

  let releaseChild = () => {}
  const childEnds = new Promise<void>(resolve => {
    releaseChild = resolve
  })
  let listed = () => {}
  const listShown = new Promise<void>(resolve => {
    listed = resolve
  })
  let stopped = () => {}
  const childStopped = new Promise<void>(resolve => {
    stopped = resolve
  })

  // Nothing sits beneath the plugin: each hook here stands for the engine.
  on('command.register', () => ({ value: { command: 'ctv' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    if (e.text.includes('stopped')) {
      stopped()
    }

    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    logs.push(e.text)
    if (e.text.includes('watch?v=abc')) {
      listed()
    }

    return { value: undefined }
  })
  on('http.fetch', (_, e) => {
    fetches.push(e as Fetch)
    const path = e.url.replace('http://ctv', '')
    const count = fetches.filter(one => one.url === e.url).length
    waiters.get(`${path}#${count}`)?.()
    const text = path === '/list'
      ? '{"ok":true,"loggedIn":true,"items":[{"id":"abc","title":"Cat","channel":"C","length":"1:00","url":"https://www.youtube.com/watch?v=abc"}]}'
      : '{}'

    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('process.spawn', async function* (_, e) {
    spawns.push(e.argv)
    // A line split across two pieces, as stdout may arrive.
    yield { stream: 'stdout' as const, text: '{"t":"re' }
    yield { stream: 'stdout' as const, text: 'ady"}\n' }
    await childEnds

    return { value: { code: 0, signal: null } }
  })

  const body = (one: Fetch | undefined) => JSON.parse(String(one?.init?.body)) as unknown
  const last = (path: string) => fetches.filter(one => one.url === `http://ctv${path}`).at(-1)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // A search starts the helper and logs the list as text.
  await $.command.run({ ...RUN, args: 'yt cats' })
  await firstList
  await listShown
  expect(spawns).toHaveLength(1)
  const argv = spawns[0] ?? []
  expect(argv[0]).toBe('node')
  expect(argv[1]).toMatch(/\/helper\/view\.mjs$/)
  expect(argv[2]).toBe('--run-dir')
  const runDir = argv[3] ?? ''
  expect(runDir).toMatch(/^\/tmp\/ctv-[0-9a-f]+$/)
  expect(argv).toHaveLength(4)
  expect(last('/list')?.init?.socketPath).toBe(`${runDir}/control.sock`)
  expect(body(last('/list'))).toEqual({
    url: 'https://www.youtube.com/results?search_query=cats',
  })
  expect(logs.some(line => line.includes('Cat') && line.includes('https://www.youtube.com/watch?v=abc'))).toBe(true)

  // A number plays that item: the page goes there and the helper shows its window.
  await $.command.run({ ...RUN, args: '1' })
  await castOn
  expect(body(last('/navigate'))).toEqual({ url: 'https://www.youtube.com/watch?v=abc' })
  expect(body(last('/cast'))).toEqual({ on: true })

  // No argument with a video loaded: hide. The reply is a log row, which the
  // model does not read; the hook's answer has no text.
  expect(await $.command.run({ ...RUN, args: '' })).toEqual({})
  expect(logs).toContain('YouTube window hidden. Sound keeps playing.')
  expect(body(last('/cast'))).toEqual({ on: false })

  // `yt` lists the home feed, also while a video is loaded.
  await $.command.run({ ...RUN, args: 'yt' })
  await secondList
  expect(body(last('/list'))).toEqual({ url: 'https://www.youtube.com/' })

  // `gray` turns black and white on in the running helper.
  expect(await $.command.run({ ...RUN, args: 'gray' })).toEqual({})
  expect(logs).toContain('YouTube: black and white on.')
  expect(body(last('/gray'))).toEqual({ on: true })

  // `mute` turns sound off, and a second `mute` keeps it off; `unmute` turns it on.
  await $.command.run({ ...RUN, args: 'mute' })
  expect(body(last('/mute'))).toEqual({ on: true })
  await $.command.run({ ...RUN, args: 'mute' })
  expect(body(last('/mute'))).toEqual({ on: true })
  await $.command.run({ ...RUN, args: 'unmute' })
  expect(body(last('/mute'))).toEqual({ on: false })

  await $.command.run({ ...RUN, args: 'bigger' })
  expect(body(last('/resize'))).toEqual({ factor: 1.25 })

  await $.command.run({ ...RUN, args: 'pause' })
  expect(last('/toggle')?.init?.method).toBe('POST')
  expect(spawns).toHaveLength(1)

  // The helper exits by itself: the state is cleared.
  releaseChild()
  await childStopped
})

test('/ctv twitch lists who you follow, plays by number, searches and asks to sign in', async ($, on) => {
  const fetches: Fetch[] = []
  const logs: string[] = []
  const toasts: string[] = []
  // One promise per log line the test waits for, settled when a line has that text.
  const waiters = new Map<string, () => void>()
  const logged = (text: string) =>
    new Promise<void>(resolve => {
      waiters.set(text, resolve)
    })
  const followedShown = logged('Twitch · following')
  const nobodyLive = logged('Twitch: nobody you follow is live.')
  const searchShown = logged('Twitch · "some text"')
  let castOn = () => {}
  const cast = new Promise<void>(resolve => {
    castOn = resolve
  })
  // Each /twitch/list answer in turn: signed in with one live channel, then
  // signed out with none, then a search the sign-in does not change.
  const lists = [
    '{"ok":true,"loggedIn":true,"items":[{"id":"cat","title":"Cat stream","channel":"Cat","length":"12 watching","url":"https://www.twitch.tv/cat"}]}',
    '{"ok":true,"loggedIn":false,"items":[]}',
    '{"ok":true,"loggedIn":false,"items":[{"id":"dog","title":"Dog stream","channel":"Dog","length":"3 watching","url":"https://www.twitch.tv/dog"}]}',
  ]

  on('command.register', () => ({ value: { command: 'ctv' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    logs.push(e.text)
    for (const [text, resolve] of waiters) {
      if (e.text.includes(text)) {
        resolve()
      }
    }

    return { value: undefined }
  })
  on('http.fetch', (_, e) => {
    fetches.push(e as Fetch)
    const path = e.url.replace('http://ctv', '')
    if (path === '/cast') {
      castOn()
    }
    const text = path === '/twitch/list' ? (lists.shift() ?? '{}') : '{}'

    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"t":"ready"}\n' }
    await new Promise<void>(() => {})

    return { value: { code: 0, signal: null } }
  })

  const body = (one: Fetch | undefined) => JSON.parse(String(one?.init?.body)) as unknown
  const last = (path: string) => fetches.filter(one => one.url === `http://ctv${path}`).at(-1)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // `twitch` lists the followed live channels, headed with the site.
  await $.command.run({ ...RUN, args: 'twitch' })
  await followedShown
  expect(body(last('/twitch/list'))).toEqual({})
  expect(logs.some(line => line.includes('Cat stream') && line.includes('https://www.twitch.tv/cat'))).toBe(true)

  // A number plays the item's own URL.
  await $.command.run({ ...RUN, args: '1' })
  await cast
  expect(body(last('/navigate'))).toEqual({ url: 'https://www.twitch.tv/cat' })
  // Messages name the site that plays.
  expect(await $.command.run({ ...RUN, args: 'pause' })).toEqual({})
  expect(logs).toContain('Twitch: play/pause.')

  // Signed out, the followed list asks for a Twitch sign-in.
  await $.command.run({ ...RUN, args: 'twitch' })
  await nobodyLive
  expect(toasts).toContain('Twitch is signed out. Run /ctv login th to sign in once.')

  // A search sends the text and needs no sign-in.
  const toastsBefore = toasts.length
  await $.command.run({ ...RUN, args: 'th some text' })
  await searchShown
  expect(body(last('/twitch/list'))).toEqual({ query: 'some text' })
  expect(toasts).toHaveLength(toastsBefore)
})

test('/ctv aliases, follow, search and the site question', async ($, on) => {
  const fetches: Fetch[] = []
  const logs: string[] = []
  const toasts: string[] = []
  const runs: (readonly string[])[] = []
  const questions: string[] = []
  // The sign-in state /accounts reports, and the answers the person gives in turn.
  let accounts = { youtube: true, twitch: false }
  const answers: string[] = []
  // Each wait settles once its check holds, checked after every fetch, log and run.
  const checks: { holds: () => boolean; resolve: () => void }[] = []
  const settle = () => {
    for (const check of [...checks]) {
      if (check.holds()) {
        checks.splice(checks.indexOf(check), 1)
        check.resolve()
      }
    }
  }
  const until = (holds: () => boolean) =>
    new Promise<void>(resolve => {
      checks.push({ holds, resolve })
      settle()
    })

  on('command.register', () => ({ value: { command: 'ctv' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    logs.push(e.text)
    settle()

    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const question = e.questions[0]?.question ?? ''
    questions.push(question)

    return { result: { questions: e.questions, answers: { [question]: answers.shift() ?? '' } } }
  })
  on('http.fetch', (_, e) => {
    fetches.push(e as Fetch)
    const path = e.url.replace('http://ctv', '')
    const sent = e.init?.body === undefined ? {} : (JSON.parse(String(e.init.body)) as { live?: boolean; query?: string })
    // A live list holds one item on each site; every other list holds none.
    const text = path === '/accounts'
      ? JSON.stringify({ ok: true, ...accounts })
      : path === '/list'
        ? sent.live === true
          ? '{"ok":true,"loggedIn":true,"items":[{"id":"yl","title":"YT live","channel":"Y","length":"","url":"https://www.youtube.com/watch?v=yl"}]}'
          : '{"ok":true,"loggedIn":false,"items":[]}'
        : path === '/twitch/list' && sent.query === undefined
          ? '{"ok":true,"loggedIn":true,"items":[{"id":"tl","title":"TH live","channel":"T","length":"5 watching","url":"https://www.twitch.tv/tl"}]}'
          : '{"ok":true,"items":[]}'
    settle()

    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"t":"ready"}\n' }
    await new Promise<void>(() => {})

    return { value: { code: 0, signal: null } }
  })
  on('process.run', (_, e) => {
    runs.push(e.argv)
    settle()

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const body = (one: Fetch | undefined) => JSON.parse(String(one?.init?.body)) as unknown
  const posts = (path: string) => fetches.filter(one => one.url === `http://ctv${path}`)
  const last = (path: string) => posts(path).at(-1)
  const after = (path: string, count: number) => until(() => posts(path).length >= count)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // `yt` alone lists the YouTube home feed; the hook's answer has no text.
  expect(await $.command.run({ ...RUN, args: 'yt' })).toEqual({})
  await after('/list', 1)
  expect(body(last('/list'))).toEqual({ url: 'https://www.youtube.com/' })
  expect(logs).toContain('YouTube: loading your home feed…')

  // `th <text>` searches Twitch; `th follow` and `twitch` list who you follow.
  await $.command.run({ ...RUN, args: 'th foo' })
  await after('/twitch/list', 1)
  expect(body(last('/twitch/list'))).toEqual({ query: 'foo' })
  await $.command.run({ ...RUN, args: 'th follow' })
  await after('/twitch/list', 2)
  expect(body(last('/twitch/list'))).toEqual({})
  await $.command.run({ ...RUN, args: 'twitch' })
  await after('/twitch/list', 3)
  expect(body(last('/twitch/list'))).toEqual({})

  // `yt follow` lists the subscriptions feed, and signed out asks for a sign-in.
  await $.command.run({ ...RUN, args: 'yt follow' })
  await after('/list', 2)
  expect(body(last('/list'))).toEqual({ url: 'https://www.youtube.com/feed/subscriptions' })
  await until(() => toasts.includes('YouTube is signed out. Run /ctv login yt to sign in once.'))

  // Only YouTube signed in: a search with no site goes there unasked, the text kept whole.
  await $.command.run({ ...RUN, args: 'search first and second' })
  await after('/list', 3)
  expect(body(last('/list'))).toEqual({
    url: 'https://www.youtube.com/results?search_query=first%20and%20second',
  })
  await $.command.run({ ...RUN, args: 'foo' })
  await after('/list', 4)
  expect(body(last('/list'))).toEqual({ url: 'https://www.youtube.com/results?search_query=foo' })
  expect(questions).toEqual([])

  // `search` with no text asks for one.
  expect(await $.command.run({ ...RUN, args: 'search' })).toEqual({})
  expect(logs).toContain('ctv: search what?')

  // Both signed in: the person picks the site.
  accounts = { youtube: true, twitch: true }
  answers.push('Twitch')
  expect(await $.command.run({ ...RUN, args: 'foo' })).toEqual({})
  await after('/twitch/list', 4)
  expect(questions).toEqual(['Which site?'])
  expect(body(last('/twitch/list'))).toEqual({ query: 'foo' })

  // Text typed under "Other" that is no site lists nothing.
  answers.push('Vimeo')
  await $.command.run({ ...RUN, args: 'bar' })
  await until(() => logs.includes('ctv: pick YouTube or Twitch.'))
  expect(posts('/twitch/list')).toHaveLength(4)
  expect(posts('/list')).toHaveLength(4)

  // `yt streaming` lists only the YouTube subscriptions that are live.
  await $.command.run({ ...RUN, args: 'yt streaming' })
  await after('/list', 5)
  expect(body(last('/list'))).toEqual({ url: 'https://www.youtube.com/feed/subscriptions', live: true })

  // `streaming` with no site asks nothing and lists both sites, numbered across both.
  await $.command.run({ ...RUN, args: 'streaming' })
  await until(() => logs.some(line => line.includes('[TH] TH live')))
  expect(questions).toHaveLength(2)
  expect(body(last('/list'))).toEqual({ url: 'https://www.youtube.com/feed/subscriptions', live: true })
  expect(posts('/list')).toHaveLength(6)
  expect(body(last('/twitch/list'))).toEqual({})
  const heading = logs.lastIndexOf('Live now · /ctv <number> plays one')
  expect(heading).toBeGreaterThan(-1)
  expect(logs[heading + 1]).toBe(' 1. [YT] YT live — Y  https://www.youtube.com/watch?v=yl')
  expect(logs[heading + 2]).toBe(' 2. [TH] TH live — T (5 watching)  https://www.twitch.tv/tl')
  await $.command.run({ ...RUN, args: '2' })
  await after('/navigate', 1)
  expect(body(last('/navigate'))).toEqual({ url: 'https://www.twitch.tv/tl' })
  expect(logs).toContain('Twitch: playing TH live')

  // Neither site signed in: a toast says to sign in.
  accounts = { youtube: false, twitch: false }
  await $.command.run({ ...RUN, args: 'streaming' })
  await until(() => toasts.includes('ctv: sign in first: /ctv login yt or /ctv login th'))
  expect(posts('/list')).toHaveLength(6)

  // `login` with no site asks which; YouTube opens the Google sign-in.
  answers.push('YouTube')
  expect(await $.command.run({ ...RUN, args: 'login' })).toEqual({})
  await until(() => runs.length === 1)
  expect(questions.at(-1)).toBe('Sign in to which site?')
  expect(runs[0]?.at(-1)).toBe('--login')

  // `login th` opens the Twitch sign-in without asking.
  await $.command.run({ ...RUN, args: 'login th' })
  expect(runs[1]?.at(-1)).toBe('--login-twitch')
  expect(questions).toHaveLength(3)
})
