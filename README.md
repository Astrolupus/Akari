# Akari

A self-hosted anime streaming site. Your library comes from GitHub repos you connect, and what you watch syncs to **AniList**, **MyAnimeList** and **Kitsu**.

- **GitHub sources**: add any repo that contains an `anime-source.json` manifest (public, or private with a token). Akari re-reads it every 30 minutes, or when you press Refresh.
- **Automatic metadata**: list an AniList id and Akari fills in the title, cover, banner, synopsis, genres, studio and MyAnimeList id.
- **Tracker sync**: when you pass 85% of an episode, Akari sets the show to Watching (or Completed on the last episode) and raises your progress on every connected tracker. It never lowers progress. You can also set status and episode count by hand on each show page.
- **Player**: MP4, WebM and HLS (`.m3u8`), WebVTT subtitles, resume where you left off, skip-intro markers, an up-next countdown, and keyboard shortcuts.
- **"On your AniList" shelf**: shows in your library that are on your AniList as watching, paused or planned.

> Only add video you have the rights to stream: your own uploads, licensed files, or openly licensed works. Akari plays the links in your manifests; it does not find or scrape video.

## Quick start

Requires Node.js 18.17 or newer. There are no dependencies to install.

```bash
cp .env.example .env     # optional for a first look
npm start                # → http://localhost:3000
```

A bundled source of Blender open movies loads on first run so the player has something to play. Turn it off with `ENABLE_SAMPLE=false`.

## Connect a GitHub repo

1. Create a repo with an `anime-source.json` at its root (start from `source-template/anime-source.json`).
2. Check it locally: `npm run validate -- path/to/anime-source.json`
3. In Akari, open **Settings → GitHub sources** and enter `owner/repo`, `owner/repo@branch`, or a github.com link. A link to a folder or a `.json` file also works.

For **private repos**, set `GITHUB_TOKEN` (a fine-grained token with read-only *Contents* access). Repo-relative files from private repos stream through Akari using that token. Public repos work without a token, though one raises GitHub's rate limit.

## Source manifest

```json
{
  "schema": "akari-source/1",
  "name": "My Anime Library",
  "description": "Optional",
  "shows": [
    {
      "slug": "my-series",
      "ids": { "anilist": 21, "mal": 21, "kitsu": 12 },
      "episodes": [
        {
          "number": 1,
          "title": "Optional",
          "src": "https://media.example.com/my-series/01/master.m3u8",
          "duration": 1440,
          "thumbnail": "thumbs/01.jpg",
          "intro": { "start": 62, "end": 152 },
          "subtitles": [{ "lang": "en", "label": "English", "src": "subs/01.en.vtt", "default": true }]
        }
      ]
    }
  ]
}
```

| Field | Notes |
| --- | --- |
| `slug` | Lowercase letters, digits, hyphens. Unique within the manifest. Changing it resets watch history for that show. |
| `ids.anilist` | Recommended. Pulls metadata from AniList and links AniList sync. |
| `ids.mal` | Optional when `ids.anilist` is set (AniList supplies it). |
| `ids.kitsu` | Optional. Otherwise Akari looks it up from the MAL or AniList id. |
| `title`, `synopsis`, `cover`, `banner`, `year`, `genres`, `studio`, `format`, `color`, `totalEpisodes`, `license` | Optional overrides. Required in practice when there is no AniList id. |
| `episodes[].src` | An `https://` URL, or a path relative to the manifest inside the repo. |
| `episodes[].intro` | Seconds. Shows a Skip intro button during that span. |

Large video files usually belong outside git: GitHub release assets, object storage (S3, R2, B2), or your own media server. Point `src` at them.

Remote video and subtitle hosts must allow your Akari origin (CORS) for subtitles and HLS to load.

## Connect trackers

Set `PUBLIC_URL` to the address you open Akari at first, because redirect URLs are built from it.

**AniList**
1. Go to <https://anilist.co/settings/developer> and create a client.
2. Redirect URL: `<PUBLIC_URL>/auth/anilist/callback`
3. Put the id and secret in `ANILIST_CLIENT_ID` and `ANILIST_CLIENT_SECRET`, restart, then Settings → Connect AniList.

**MyAnimeList**
1. Go to <https://myanimelist.net/apiconfig> and create an ID. Choose App Type **web**.
2. App Redirect URL: `<PUBLIC_URL>/auth/mal/callback`
3. Put the id and secret in `MAL_CLIENT_ID` and `MAL_CLIENT_SECRET`, restart, then Settings → Connect MyAnimeList.

**Kitsu**: no app needed. Sign in from Settings with your Kitsu email and password. Akari stores the access token, not the password. If Kitsu's API moves, change `KITSU_API_BASE`.

## Web version (GitHub Pages)

`npm run build:pages` builds a browser-only copy of Akari into `dist/`, published from the `gh-pages` branch. It needs no server, with these limits:

- Public GitHub repos only.
- AniList: each visitor registers a free AniList client once (redirect URL = the site's address) and pastes its client ID in Settings. To skip that for everyone, build with `ANILIST_CLIENT_ID_WEB=<id> npm run build:pages`.
- Kitsu: works if Kitsu allows sign-in from other sites; otherwise use the server version.
- MyAnimeList: not available, because its API blocks calls from web pages on other sites.
- Sources, watch progress and sign-ins are stored in that browser only.

To publish an update: `npm run build:pages`, then push the contents of `dist/` to the `gh-pages` branch.

## Running on a server

- Set `HOST=0.0.0.0`, `PUBLIC_URL=https://your.domain`, and **`APP_PASSWORD`**. Akari is single-user: anyone who can open it can change your tracker lists.
- Put it behind HTTPS (Caddy, nginx, a tunnel).
- Everything Akari remembers lives in `data/` (sources, watch progress, tracker tokens, metadata cache). Back it up, and keep it private.

## Layout

```
server.js            HTTP server: API, OAuth callbacks, private-repo media proxy
lib/http.js          Tiny router, JSON and static/Range file helpers
lib/sources.js       GitHub sources and catalog building
lib/github.js        GitHub API calls and repo-input parsing
lib/manifest.js      Manifest validation
lib/anilist.js       AniList GraphQL + metadata cache
lib/trackers.js      AniList, MyAnimeList and Kitsu auth and list sync
public/              The front end (no build step)
web/static-backend.js  Browser stand-in for the server, used by the Pages build
scripts/build-pages.js Builds dist/ for GitHub Pages
sources/sample/      Bundled open-movie source
source-template/     A starting manifest for your own repo
```
