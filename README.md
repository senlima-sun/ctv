# ctv

A Claude Code mod that plays a small live video in a floating panel at the bottom-right of your Mac screen while you work. It lists and plays YouTube (your home feed, a search, or any link) through a headless Google Chrome that uses your own Google sign-in, and Twitch (the live channels you follow, a search, live streams and past broadcasts) played natively in the panel. You control it with `/ctv` commands in Claude Code.

| Command | What it does |
| --- | --- |
| `/ctv` | List your YouTube home feed; when a video is loaded, hide or show the panel |
| `/ctv home` | List your YouTube home feed |
| `/ctv <text>` | Search YouTube |
| `/ctv twitch` | List the Twitch channels you follow that are live |
| `/ctv twitch <text>` | Search Twitch |
| `/ctv <number>` | Play that item from the last list |
| `/ctv <url>` | Play a YouTube or Twitch link |
| `/ctv pause` | Play or pause |
| `/ctv mute`, `/ctv unmute` | Sound off or on |
| `/ctv bigger`, `/ctv smaller` | Resize the panel |
| `/ctv gray` | Black and white on or off |
| `/ctv off` | Stop and close the panel |
| `/ctv login` | Open Chrome to sign in to Google |
| `/ctv login twitch` | Open Chrome to sign in to Twitch |

## Requirements

- macOS
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

Sign in once: `/ctv login` for YouTube and `/ctv login twitch` for Twitch. Each opens a normal Chrome window; sign in there, close it, and come back. The first video you play builds the panel app with `swiftc`, which takes a moment.

## Your data

Everything ctv keeps is in `~/Library/Application Support/ctv`: the Chrome profile with your sign-ins and the built panel app. Nothing is sent anywhere else.

To remove ctv:

```
claude plugin uninstall ctv@ctv
claude plugin marketplace remove ctv
rm -rf ~/Library/Application\ Support/ctv
```

## Notes

A personal, non-commercial tool. It shows the real sites in your own signed-in browser; it does not block ads or download videos. Not affiliated with YouTube or Twitch.

## License

MIT, see [LICENSE](LICENSE).
