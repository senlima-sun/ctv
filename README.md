# ctv

A Claude Code mod that plays a small live video in a floating panel at the bottom-right of your Mac screen while you work. It lists and plays YouTube (your home feed, a search, or any link) through a headless Google Chrome that uses your own Google sign-in, and Twitch (the live channels you follow, a search, live streams and past broadcasts) played natively in the panel. You control it with `/ctv` commands in Claude Code.

macOS only (it uses a native AppKit panel and AVPlayer).

| Command                                  | What it does                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/ctv`                                   | When a video is loaded, hide or show the panel; else list the start of a site (YouTube home, Twitch follow) |
| `/ctv yt`, `/ctv youtube`                | List your YouTube home feed                                                                                 |
| `/ctv th`, `/ctv twitch`                 | List the Twitch channels you follow that are live                                                           |
| `/ctv [yt \| th] search <text>`          | Search; all the text after `search` is the query                                                            |
| `/ctv [yt \| th] <text>`                 | Search, the same as `search <text>`                                                                         |
| `/ctv [yt \| th] follow`                 | YouTube: your subscriptions feed; Twitch: the channels you follow that are live                             |
| `/ctv yt streaming`, `/ctv th streaming` | The channels you follow on that site that are live now                                                      |
| `/ctv streaming`                         | Who is live now on every site you are signed in to, in one list                                             |
| `/ctv <number>`                          | Play that item from the last list                                                                           |
| `/ctv <url>`                             | Play a YouTube or Twitch link                                                                               |
| `/ctv pause`                             | Play or pause                                                                                               |
| `/ctv mute`, `/ctv unmute`               | Sound off or on                                                                                             |
| `/ctv bigger`, `/ctv smaller`            | Resize the panel                                                                                            |
| `/ctv gray`                              | Black and white on or off                                                                                   |
| `/ctv off`                               | Stop and close the panel                                                                                    |
| `/ctv login [yt \| th]`                  | Open Chrome to sign in to Google (`yt`) or Twitch (`th`); with no site, ctv asks which                      |

With no site named, ctv uses the site you are signed in to. When you are signed in to both or to neither, it asks which site. Replies show in the transcript only; they are not sent to Claude.

## Requirements

- macOS (the only supported platform)
- Google Chrome in `/Applications`
- Node.js 20.11 or newer on your `PATH` as `node`
- Xcode Command Line Tools, for `swiftc` (`xcode-select --install`)

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install ctv --marketplace senlima-sun/ctv
```

Answer `y` to add the marketplace, then pick a scope (user is first). Or in two steps:

```
/plugin marketplace add senlima-sun/ctv
/plugin install ctv@ctv
```

From a shell:

```
claude plugin marketplace add senlima-sun/ctv
claude plugin install ctv@ctv
```

## First run

Sign in once: `/ctv login yt` for YouTube and `/ctv login th` for Twitch. Each opens a normal Chrome window; sign in there, close it, and come back. The first video you play builds the panel app with `swiftc`, which takes a moment.

## Your data

Everything ctv keeps is in `~/Library/Application Support/ctv`: the Chrome profile with your sign-ins and the built panel app. Nothing is sent anywhere else.

To remove ctv:

```
claude plugin uninstall ctv@ctv
claude plugin marketplace remove ctv
rm -rf ~/Library/Application\ Support/ctv
```

## Development

```
npm run check
claude plugin test .
xcrun swift-format format -i helper/panel.swift
```

`npm run check` runs oxfmt and oxlint through `npx` at pinned versions, so the repo has no dependencies at all and an install pulls nothing extra. `npm run fmt` formats the files.

## Notes

A personal, non-commercial tool. It shows the real sites in your own signed-in browser; it does not block ads or download videos. Not affiliated with YouTube or Twitch.

## License

MIT, see [LICENSE](LICENSE).
