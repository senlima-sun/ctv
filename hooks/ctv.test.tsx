import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { Video } from '../types'

const RUN = {
  command: 'ctv',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 200 },
} as const

type Fetch = { url: string; init?: { method?: string; body?: unknown; socketPath?: string } }
type Sent = { live?: boolean; query?: string }

const video = (id: string, title: string, channel: string, length: string, url: string): Video => ({
  id,
  title,
  channel,
  length,
  url,
})
const list = (loggedIn: boolean | undefined, ...items: Video[]) =>
  JSON.stringify({ ok: true, loggedIn, items })

// Nothing sits beneath the plugin: each hook here stands for the engine.
function fakeEngine(
  on: On,
  reply: (path: string, sent: Sent) => string,
  childEnds = new Promise<void>(() => {}),
) {
  const fetches: Fetch[] = []
  const logs: string[] = []
  const toasts: string[] = []
  const spawns: (readonly string[])[] = []
  const runs: (readonly string[])[] = []
  const questions: string[] = []
  const answers: string[] = []
  // Each wait settles once its check holds, checked after every fetch, log, toast and run.
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
    settle()

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
    const sent = e.init?.body === undefined ? {} : (JSON.parse(String(e.init.body)) as Sent)
    const text = reply(e.url.replace('http://ctv', ''), sent)
    settle()

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
  on('process.run', (_, e) => {
    runs.push(e.argv)
    settle()

    return {
      value: {
        exitCode: 0,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  const posts = (path: string) => fetches.filter(one => one.url === `http://ctv${path}`)

  return {
    logs,
    toasts,
    spawns,
    runs,
    questions,
    answers,
    posts,
    until,
    body: (one: Fetch | undefined) => JSON.parse(String(one?.init?.body)) as unknown,
    last: (path: string) => posts(path).at(-1),
    after: (path: string, count: number) => until(() => posts(path).length >= count),
  }
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

test('/ctv lists, plays by number, hides, lists home and pauses', async ($, on) => {
  let releaseChild = () => {}
  const childEnds = new Promise<void>(resolve => {
    releaseChild = resolve
  })
  const cat = video('abc', 'Cat', 'C', '1:00', 'https://www.youtube.com/watch?v=abc')
  const { logs, toasts, spawns, until, after, body, last } = fakeEngine(
    on,
    path => (path === '/list' ? list(true, cat) : '{}'),
    childEnds,
  )

  await $.session.start(START)

  await $.command.run({ ...RUN, args: 'yt cats' })
  await after('/list', 1)
  await until(() => logs.some(line => line.includes('watch?v=abc')))
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
  expect(
    logs.some(line => line.includes('Cat') && line.includes('https://www.youtube.com/watch?v=abc')),
  ).toBe(true)

  await $.command.run({ ...RUN, args: '1' })
  await after('/cast', 1)
  expect(body(last('/navigate'))).toEqual({ url: 'https://www.youtube.com/watch?v=abc' })
  expect(body(last('/cast'))).toEqual({ on: true })

  // No argument with a video loaded hides it.
  expect(await $.command.run({ ...RUN, args: '' })).toEqual({})
  expect(logs).toContain('YouTube window hidden. Sound keeps playing.')
  expect(body(last('/cast'))).toEqual({ on: false })

  await $.command.run({ ...RUN, args: 'yt' })
  await after('/list', 2)
  expect(body(last('/list'))).toEqual({ url: 'https://www.youtube.com/' })

  expect(await $.command.run({ ...RUN, args: 'gray' })).toEqual({})
  expect(logs).toContain('YouTube: black and white on.')
  expect(body(last('/gray'))).toEqual({ on: true })

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

  releaseChild()
  await until(() => toasts.some(text => text.includes('stopped')))
})

test('/ctv twitch lists who you follow, plays by number, searches and asks to sign in', async ($, on) => {
  // Signed in with one live channel, then signed out with none, then a search.
  const lists = [
    list(true, video('cat', 'Cat stream', 'Cat', '12 watching', 'https://www.twitch.tv/cat')),
    list(false),
    list(false, video('dog', 'Dog stream', 'Dog', '3 watching', 'https://www.twitch.tv/dog')),
  ]
  const { logs, toasts, until, after, body, last } = fakeEngine(on, path =>
    path === '/twitch/list' ? (lists.shift() ?? '{}') : '{}',
  )
  const logged = (text: string) => until(() => logs.some(line => line.includes(text)))

  await $.session.start(START)

  await $.command.run({ ...RUN, args: 'twitch' })
  await logged('Twitch · following')
  expect(body(last('/twitch/list'))).toEqual({})
  expect(
    logs.some(line => line.includes('Cat stream') && line.includes('https://www.twitch.tv/cat')),
  ).toBe(true)

  await $.command.run({ ...RUN, args: '1' })
  await after('/cast', 1)
  expect(body(last('/navigate'))).toEqual({ url: 'https://www.twitch.tv/cat' })
  expect(await $.command.run({ ...RUN, args: 'pause' })).toEqual({})
  expect(logs).toContain('Twitch: play/pause.')

  await $.command.run({ ...RUN, args: 'twitch' })
  await logged('Twitch: nobody you follow is live.')
  expect(toasts).toContain('Twitch is signed out. Run /ctv login th to sign in once.')

  const toastsBefore = toasts.length
  await $.command.run({ ...RUN, args: 'th some text' })
  await logged('Twitch · "some text"')
  expect(body(last('/twitch/list'))).toEqual({ query: 'some text' })
  expect(toasts).toHaveLength(toastsBefore)
})

test('/ctv aliases, follow, search and the site question', async ($, on) => {
  let accounts = { youtube: true, twitch: false }
  const ytLive = video('yl', 'YT live', 'Y', '', 'https://www.youtube.com/watch?v=yl')
  const thLive = video('tl', 'TH live', 'T', '5 watching', 'https://www.twitch.tv/tl')
  // A live list holds one item on each site; every other list holds none.
  const { logs, toasts, runs, questions, answers, until, after, body, last, posts } = fakeEngine(
    on,
    (path, sent) => {
      if (path === '/accounts') {
        return JSON.stringify({ ok: true, ...accounts })
      }
      if (path === '/list') {
        return sent.live === true ? list(true, ytLive) : list(false)
      }

      return path === '/twitch/list' && sent.query === undefined
        ? list(true, thLive)
        : list(undefined)
    },
  )

  await $.session.start(START)

  expect(await $.command.run({ ...RUN, args: 'yt' })).toEqual({})
  await after('/list', 1)
  expect(body(last('/list'))).toEqual({ url: 'https://www.youtube.com/' })
  expect(logs).toContain('YouTube: loading your home feed…')

  await $.command.run({ ...RUN, args: 'th foo' })
  await after('/twitch/list', 1)
  expect(body(last('/twitch/list'))).toEqual({ query: 'foo' })
  await $.command.run({ ...RUN, args: 'th follow' })
  await after('/twitch/list', 2)
  expect(body(last('/twitch/list'))).toEqual({})
  await $.command.run({ ...RUN, args: 'twitch' })
  await after('/twitch/list', 3)
  expect(body(last('/twitch/list'))).toEqual({})

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

  expect(await $.command.run({ ...RUN, args: 'search' })).toEqual({})
  expect(logs).toContain('ctv: search what?')

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

  await $.command.run({ ...RUN, args: 'yt streaming' })
  await after('/list', 5)
  expect(body(last('/list'))).toEqual({
    url: 'https://www.youtube.com/feed/subscriptions',
    live: true,
  })

  await $.command.run({ ...RUN, args: 'streaming' })
  await until(() => logs.some(line => line.includes('[TH] TH live')))
  expect(questions).toHaveLength(2)
  expect(body(last('/list'))).toEqual({
    url: 'https://www.youtube.com/feed/subscriptions',
    live: true,
  })
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

  accounts = { youtube: false, twitch: false }
  await $.command.run({ ...RUN, args: 'streaming' })
  await until(() => toasts.includes('ctv: sign in first: /ctv login yt or /ctv login th'))
  expect(posts('/list')).toHaveLength(6)

  answers.push('YouTube')
  expect(await $.command.run({ ...RUN, args: 'login' })).toEqual({})
  await until(() => runs.length === 1)
  expect(questions.at(-1)).toBe('Sign in to which site?')
  expect(runs[0]?.at(-1)).toBe('--login')

  await $.command.run({ ...RUN, args: 'login th' })
  expect(runs[1]?.at(-1)).toBe('--login-twitch')
  expect(questions).toHaveLength(3)
})
