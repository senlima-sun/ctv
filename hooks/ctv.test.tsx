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
    if (e.text.includes('youtu.be')) {
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
      ? '{"ok":true,"loggedIn":true,"items":[{"id":"abc","title":"Cat","channel":"C","length":"1:00"}]}'
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
  expect(logs.some(line => line.includes('Cat') && line.includes('https://youtu.be/abc'))).toBe(true)

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
