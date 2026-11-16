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
  await $.command.run({ ...RUN, args: 'cats' })
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

  // No argument with a video loaded: hide.
  await $.command.run({ ...RUN, args: '' })
  expect(body(last('/cast'))).toEqual({ on: false })

  // `home` lists the home feed, also while a video is loaded.
  await $.command.run({ ...RUN, args: 'home' })
  await secondList
  expect(body(last('/list'))).toEqual({ url: 'https://www.youtube.com/' })

  // `gray` turns black and white on in the running helper.
  await $.command.run({ ...RUN, args: 'gray' })
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

  // Signed out, the followed list asks for a Twitch sign-in.
  await $.command.run({ ...RUN, args: 'twitch' })
  await nobodyLive
  expect(toasts).toContain('Twitch is signed out. Run /ctv login twitch to sign in once.')

  // A search sends the text and needs no sign-in.
  const toastsBefore = toasts.length
  await $.command.run({ ...RUN, args: 'twitch some text' })
  await searchShown
  expect(body(last('/twitch/list'))).toEqual({ query: 'some text' })
  expect(toasts).toHaveLength(toastsBefore)
})
