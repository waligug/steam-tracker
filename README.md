# steam-tracker

Tracks upcoming Steam releases by genre/tag, and — more usefully — which of them are
**climbing Steam's wishlist rankings**.

**Live site: https://waligug.github.io/steam-tracker/**

## Why rank movement

Steam publishes no wishlist counts, and unreleased games have no reviews and no player
counts by definition. The only pre-release traction signal that exists is a game's
*position* in Steam's wishlist-ordered "Popular Upcoming" list. A single position is
trivia; a position that moved from #47 to #14 in a week is a signal. So this takes a
daily snapshot and diffs them.

## Two halves, one data layer

- A **GitHub Action** runs `node dist/index.js --snapshot` daily, commits the snapshot
  to `data/snapshots/`, and regenerates `data/site/*.json`. GitHub Pages serves the
  static page from the repo root.
- An **MCP server** (`dist/index.js` with no args) reads the same committed JSON, so
  asking Claude a question costs zero Steam requests.

## MCP tools

`find_upcoming` · `whats_trending` · `list_tags` · `get_game` · `take_snapshot` ·
`set_categories` · `get_config`

## Setup

```
npm install
npm run build
```

Register with Claude Code:

```
claude mcp add --scope user steam-tracker -- node C:\claude\steam-tracker\dist\index.js
```

Take a snapshot by hand (also commits and pushes):

```
npm run snapshot
```

## Data sources

All public, no API key required: Steam's store search (`infinite=1&json=1`),
`IStoreService/GetTagList`, `api/appdetails`, `appreviews`,
`GetNumberOfCurrentPlayers`, and optionally SteamSpy. Requests are throttled per host.
