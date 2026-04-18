# Social Preview Inspector

A zero-dependency, static HTML tool that lets you paste any URL and see **exactly how it will appear** when shared on 15 major platforms — side by side, with the real UI styling of each.

## ✨ Features

- **15 social previews** with authentic rendering: WhatsApp, Telegram, iMessage, Signal, Skype, Facebook, X (Twitter), LinkedIn, Mastodon, Bluesky, Slack, Discord, Reddit, Pinterest, Google Search.
- **Accurate behavior per platform**: previews where the card adapts to the image (WhatsApp, iMessage, Discord, Telegram, Bluesky, Mastodon, Signal, Skype) vs. where they always crop to 1.91:1 (Facebook, X, LinkedIn) vs. small square thumbnails (Slack, Reddit).
- **Site scanner**: paste a homepage URL and auto-discover up to **100 internal pages** with one click.
- **Meta tag analyzer**: shows detected `og:title`, `og:description`, `og:image`, `og:site_name`, canonical URL.
- **Image diagnostics**: fetches the OG image and reports real dimensions, aspect ratio, file size in KB.
- **Smart warnings**: flags common problems — image too small, above WhatsApp's ~300 KB limit, ratio that Facebook/Twitter/LinkedIn will crop, broken image URL, missing meta tags.
- **Authentic SVG logos** from Simple Icons (no emoji, no placeholders).
- **Dark & light themes** — toggle in sidebar footer, preference persists via `localStorage`.
- **CORS proxy cascade**: 4 fallback proxies (corsproxy.io, allorigins, codetabs) with 8s timeout each — keeps working when any single proxy goes down.
- **In-memory cache**: clicking the same link twice is instant; "Refresh" button bypasses cache.
- **No build step**: pure HTML + CSS + vanilla JS. Drop anywhere.

## 🚀 Run locally

```sh
# Option 1: just open the file
open index.html

# Option 2: serve over localhost (recommended — some image fetches require http(s))
python3 -m http.server 8000
# then visit http://localhost:8000
```

## 📦 Deploy

Works on any static host. Just upload the two files:

- `index.html`
- `app.js`

Tested on: **GitHub Pages**, **Cloudflare Pages**, **Netlify**, **Vercel**, **Surge**.

## 🔧 How it works

1. You paste a URL (or scan a site to extract internal links).
2. The tool fetches the page HTML through a chain of public CORS proxies.
3. It parses meta tags with `DOMParser` client-side.
4. It renders 15 per-platform preview cards using the detected meta.
5. It then re-fetches the `og:image` as a blob to read its real dimensions + file size, and surfaces warnings when the image is too big / too small / wrong ratio.

No backend. No tracking. No data leaves the browser except the CORS proxy request (which only forwards the target HTML back to you).

## 🧭 Why it exists

Existing tools like `opengraph.xyz`, `metatags.io`, `socialsharepreview.com` all render previews with the *same generic mock*. This tool aims to be **faithful to each platform's actual behavior** — including the asymmetry where some crop and some adapt — and to report the real image diagnostics you need to fix issues.

## 🪪 License

MIT — use it, fork it, ship it.

## 🙌 Credits

- Logos: [Simple Icons](https://simpleicons.org/) (CC0)
- Design inspiration: glass morphism patterns, Apple-like neutral palette
- CORS proxies: [corsproxy.io](https://corsproxy.io/), [allorigins](https://allorigins.win/), [codetabs](https://codetabs.com/)
