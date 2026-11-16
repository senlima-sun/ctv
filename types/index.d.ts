// On Twitch, `id` is the channel login and `length` says how many are watching.
export type Video = { id: string; title: string; channel: string; length: string; url: string }

declare module 'claude-code' {
  interface PluginState {
    ctv: {
      running: boolean
      shown: boolean
      title: string
      runDir: string | null
      gray: boolean
      muted: boolean
    }
  }
}
