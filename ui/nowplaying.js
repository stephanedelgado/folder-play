/**
 * ui/nowplaying.js
 * Now-playing bar: waveform, transport, MediaSession, keyboard media keys.
 */

import { player } from '../player.js';

const bar = document.getElementById('now-playing-bar');
let _rafId  = null;
let _canvas = null;
let _ctx2d  = null;

function formatTime(secs) {
  if (!isFinite(secs) || isNaN(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Seek-bar fill (painted via CSS custom property) ───────────────────────────

function setSeekFill(el, pct) {
  el.style.setProperty('--seek-fill', `${pct}%`);
}

// ── Render DOM ────────────────────────────────────────────────────────────────

function render() {
  bar.innerHTML = `
    <div class="np__waveform-wrap">
      <canvas id="np-canvas" class="np__canvas"></canvas>
    </div>
    <div class="np__track-info">
      <div class="np__title" id="np-title">—</div>
      <div class="np__album" id="np-album"></div>
    </div>
    <div class="np__controls">
      <button class="np__btn" id="np-prev" title="Previous (F7)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="19,20 9,12 19,4"/><rect x="5" y="4" width="3" height="16"/>
        </svg>
      </button>
      <button class="np__btn np__btn--play" id="np-play" title="Play/Pause (F8)">
        <svg id="np-play-icon" width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5,3 19,12 5,21"/>
        </svg>
      </button>
      <button class="np__btn" id="np-next" title="Next (F9)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5,4 15,12 5,20"/><rect x="16" y="4" width="3" height="16"/>
        </svg>
      </button>
    </div>
    <div class="np__seek-wrap">
      <span class="np__time np__time--current" id="np-current">0:00</span>
      <input type="range" id="np-seek" class="np__seek" min="0" max="100" step="0.1" value="0">
      <span class="np__time np__time--duration" id="np-duration">0:00</span>
    </div>
    <div class="np__volume-wrap">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
      </svg>
      <input type="range" id="np-volume" class="np__volume" min="0" max="1" step="0.02" value="1">
    </div>
  `;

  _canvas = document.getElementById('np-canvas');
  _ctx2d  = _canvas.getContext('2d');
  // Initialise play icon nudge
  updatePlayIcon();

  // Controls
  document.getElementById('np-prev').addEventListener('click', () => player.prev());
  document.getElementById('np-next').addEventListener('click', () => player.next());
  document.getElementById('np-play').addEventListener('click', () => player.togglePlayPause());

  // Seek
  const seekEl = document.getElementById('np-seek');
  let seeking = false;
  seekEl.addEventListener('mousedown', () => { seeking = true; });
  seekEl.addEventListener('input', () => {
    setSeekFill(seekEl, seekEl.value);
    if (!seeking) return;
    document.getElementById('np-current').textContent =
      formatTime((seekEl.value / 100) * player.duration);
  });
  seekEl.addEventListener('change', () => {
    seeking = false;
    player.seek((seekEl.value / 100) * player.duration);
  });

  // Volume
  const volEl = document.getElementById('np-volume');
  volEl.value = player.volume;
  volEl.addEventListener('input', () => player.setVolume(parseFloat(volEl.value)));
}

// ── Play icon ─────────────────────────────────────────────────────────────────

function updatePlayIcon() {
  const icon = document.getElementById('np-play-icon');
  if (!icon) return;
  if (player.isPlaying) {
    icon.innerHTML = `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`;
    icon.style.transform = '';
  } else {
    icon.innerHTML = `<polygon points="5,3 19,12 5,21"/>`;
    icon.style.transform = 'translateX(1px)';
  }
}

// ── Track info ────────────────────────────────────────────────────────────────

function updateTrackInfo(track, album) {
  const titleEl = document.getElementById('np-title');
  const albumEl = document.getElementById('np-album');
  if (titleEl) {
    titleEl.textContent = track
      ? track.name.replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]+/, '')
      : '—';
  }
  if (albumEl && album) albumEl.textContent = `${album.artist} — ${album.title}`;
}

// ── Waveform ──────────────────────────────────────────────────────────────────

function drawWaveform() {
  if (!_canvas || !_ctx2d) return;
  const data = player.getTimeDomainData();
  if (!data) return;

  const w = _canvas.offsetWidth, h = _canvas.offsetHeight;
  if (_canvas.width !== w || _canvas.height !== h) { _canvas.width = w; _canvas.height = h; }

  _ctx2d.clearRect(0, 0, w, h);
  _ctx2d.beginPath();
  _ctx2d.strokeStyle = 'rgba(255,255,255,0.55)';
  _ctx2d.lineWidth = 1.5;

  const sliceWidth = w / data.length;
  let x = 0;
  for (let i = 0; i < data.length; i++) {
    const y = ((data[i] / 128.0) * h) / 2;
    i === 0 ? _ctx2d.moveTo(x, y) : _ctx2d.lineTo(x, y);
    x += sliceWidth;
  }
  _ctx2d.stroke();
}

function animate() {
  if (player.isPlaying) {
    drawWaveform();
    _rafId = requestAnimationFrame(animate);
  } else {
    drawWaveform();
    _rafId = null;
  }
}

function startAnimate() {
  if (_rafId) cancelAnimationFrame(_rafId);
  _rafId = requestAnimationFrame(animate);
}

// ── MediaSession API ──────────────────────────────────────────────────────────

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.setActionHandler('play',          () => player.play());
  navigator.mediaSession.setActionHandler('pause',         () => player.pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => player.prev());
  navigator.mediaSession.setActionHandler('nexttrack',     () => player.next());
}

function updateMediaSessionMetadata(track, album) {
  if (!('mediaSession' in navigator)) return;
  const title = track
    ? track.name.replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]+/, '')
    : '';
  const artwork = album?.cover ? [{ src: album.cover, sizes: '512x512', type: 'image/jpeg' }] : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist: album?.artist || '',
    album:  album?.title  || '',
    artwork,
  });
  navigator.mediaSession.playbackState = 'playing';
}

// ── Events ────────────────────────────────────────────────────────────────────

player.addEventListener('trackchange', e => {
  const { track, album } = e.detail;
  bar.classList.remove('hidden');
  updateTrackInfo(track, album);
  updatePlayIcon();
  updateMediaSessionMetadata(track, album);
  startAnimate();
});

player.addEventListener('statechange', () => {
  updatePlayIcon();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = player.isPlaying ? 'playing' : 'paused';
  }
  if (player.isPlaying && !_rafId) startAnimate();
});

player.addEventListener('timeupdate', e => {
  const { currentTime, duration } = e.detail;
  const curEl  = document.getElementById('np-current');
  const durEl  = document.getElementById('np-duration');
  const seekEl = document.getElementById('np-seek');
  if (curEl)  curEl.textContent = formatTime(currentTime);
  if (durEl)  durEl.textContent = formatTime(duration);
  if (seekEl && duration > 0) {
    const pct = (currentTime / duration) * 100;
    seekEl.value = pct;
    setSeekFill(seekEl, pct);
  }
});

// ── Keyboard: Space, ⌘← ⌘→, F7 F8 F9 ────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.code === 'Space') {
    e.preventDefault();
    player.togglePlayPause();
  } else if (e.code === 'ArrowRight' && e.metaKey) {
    player.next();
  } else if (e.code === 'ArrowLeft' && e.metaKey) {
    player.prev();
  } else if (e.key === 'F7') {
    e.preventDefault();
    player.prev();
  } else if (e.key === 'F8') {
    e.preventDefault();
    player.togglePlayPause();
  } else if (e.key === 'F9') {
    e.preventDefault();
    player.next();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

setupMediaSession();
render();
