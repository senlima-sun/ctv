// One video of a list the helper read off a YouTube page.
export type Video = { id: string; title: string; channel: string; length: string }

declare module 'claude-code' {
  interface PluginState {
    'ctv': {
      running: boolean
      shown: boolean
      title: string
      runDir: string | null
      gray: boolean
      muted: boolean
    }
  }
}
