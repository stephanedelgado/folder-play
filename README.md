# Folder.play

A minimal browser-based music player for local libraries.

Here's a minimal browser-based music player I built in my spare time. Tired of listening to files on VLC, I wanted a more visual experience. If you have loads of music folders on your laptop, you may find it useful too.

## How it works

Drop a folder into the browser and it organises your albums into a grid. Pulls cover art from embedded tags or image files in your folders. Your files never leave your machine.

## Features

- Album grid with zoom slider
- Cover art from embedded tags or folder images
- Favourites, play counts, sorting
- Health indicator for albums missing artwork or tags
- Right-click to copy path, rescan, or edit metadata
- Keyboard media controls (F7 / F8 / F9)
- Works with FLAC, WAV, MP3, AAC and most other formats

## No server. No install. No sync.

Just drop a folder and play.

**Works in Chrome on macOS.**

→ [stephanedelgado.github.io/folder-play](https://stephanedelgado.github.io/folder-play)

## Usage

1. Open the app in Chrome
2. Drop your music folder into the window
3. Browse your albums

To revisit the library on next visit, drop the same folder again — the app resyncs instantly from its local cache.

## Built with

No frameworks. No dependencies. Just browser APIs:

- **File System Access API** — reads your local folder and re-reads it live on rescan, without freezing file references
- **Web Audio API** — audio decoding and playback
- **IndexedDB** — persists your library index, cover art cache, favourites, play counts, and metadata overrides across sessions
- **MediaSession API** — integrates with macOS media controls, Touch Bar, and keyboard media keys (F7 / F8 / F9)
- **ID3v2 / FLAC metadata parsing** — custom implementation that reads the full tag header size before slicing, avoiding truncated cover art from large embedded images

## Local development

No build step. Clone the repo and open `index.html` in Chrome.

## License

MIT
