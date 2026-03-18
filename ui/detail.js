/**
 * ui/detail.js
 * Full-screen album detail: tracklist on left, cover + info on right.
 */

import { player } from '../player.js';
import { showEditModal } from './grid.js';
import { IMAGE_EXTS } from '../scanner.js';
import { updateAlbumField, getPref } from '../db.js';
import { showToast } from './toast.js';

function ext(name) { return name.slice(name.lastIndexOf('.') + 1).toLowerCase(); }
function escHtml(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function displayName(filename) {
  return filename.replace(/\.[^.]+$/, '').replace(/^\d+[\s._\-]+/, '');
}

const STAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

const ICON_COPY_PATH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="m2 2 7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>`;

const MISSING_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <polyline points="21 15 16 10 5 21"/>
  </svg>`;

let _currentAlbum  = null;
let _currentTracks = [];
let _navIndex      = 0;
let _galleryUrls   = [];

function setNavIndex(i) {
  _navIndex = i;
  document.querySelectorAll('.tracklist__row').forEach(row => {
    row.classList.toggle('is-nav', parseInt(row.dataset.index, 10) === i);
  });
  const row = document.querySelector(`.tracklist__row[data-index="${i}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

async function copyTrackFilePath(file) {
  const root = await getPref('musicRoot', '');
  let path = file.webkitRelativePath || file.name;
  if (root) {
    const rel = path.split('/').slice(1).join('/');
    path = rel ? `${root}/${rel}` : root;
  }
  navigator.clipboard.writeText(path).then(() => {
    showToast(`Path copied \u2014 press \u2318\u21E7G in Finder to navigate`);
  });
}

export function showDetail(album) {
  _currentAlbum  = album;
  _currentTracks = [...(album.audioFiles || [])].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true })
  );
  const tracks = _currentTracks;
  const panel = document.getElementById('detail-panel');

  const images = [...(album.imageFiles || [])].filter(f => IMAGE_EXTS.has(ext(f.name)));
  _galleryUrls.forEach(u => URL.revokeObjectURL(u));
  _galleryUrls = [];

  const coverHtml = album.cover
    ? `<img class="detail__cover" src="${album.cover}" alt="Cover">`
    : `<div class="detail__cover-placeholder">${MISSING_SVG}</div>`;

  panel.innerHTML = `
    <div class="detail__topbar">
      <button class="detail__back icon-btn" title="Back to library">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </button>
      <div class="detail__topbar-title">${escHtml(album.artist)} &mdash; ${escHtml(album.title)}</div>
    </div>
    <div class="detail__body">
      <div class="detail__left" tabindex="-1">
        <table class="tracklist">
          <thead>
            <tr>
              <th class="tracklist__num">#</th>
              <th>Title</th>
            </tr>
          </thead>
          <tbody id="tracklist-body">
            ${tracks.map((f, i) => `
              <tr class="tracklist__row" data-index="${i}">
                <td class="tracklist__num">
                  <span class="tracklist__num-text">${i + 1}</span>
                  <button class="tracklist__play-btn" aria-label="Play">&#9654;&#xFE0E;</button>
                </td>
                <td class="tracklist__name">${escHtml(displayName(f.name))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="detail__right">
        ${coverHtml}
        <div class="detail__right-header">
          <div class="detail__right-meta">
            <div class="detail__title">${escHtml(album.title)}</div>
            <div class="detail__artist">${escHtml(album.artist)}</div>
            ${album.year ? `<div class="detail__year">${escHtml(album.year)}</div>` : ''}
            <div class="detail__stats">
              ${tracks.length} track${tracks.length !== 1 ? 's' : ''}
              ${album.format ? `<span class="detail__format">${escHtml(album.format)}</span>` : ''}
            </div>
          </div>
          <button class="detail__fav ${album.favourite ? 'is-fav' : ''}" title="Toggle favourite" aria-label="Favourite">${STAR_SVG}</button>
        </div>
        <div class="detail__actions">
          <button class="btn btn--primary detail__play-all">&#9654;&#xFE0E; Play all</button>
          <button class="btn btn--ghost detail__edit"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit</button>
        </div>
        ${images.length > 1 ? `
        <div class="detail__gallery">
          ${images.map(f => { const u = URL.createObjectURL(f); _galleryUrls.push(u); return `<img class="gallery-thumb" src="${u}" alt="${escHtml(f.name)}" loading="lazy">`; }).join('')}
        </div>` : ''}
      </div>
    </div>
  `;

  panel.classList.remove('hidden');

  // Keyboard nav: start cursor at playing track (if this album), else 0
  _navIndex = (player.queueAlbum?.id === album.id) ? (player.currentIndex || 0) : 0;

  updateTrackHighlight();
  setNavIndex(_navIndex);

  // Focus tracklist so arrow keys work immediately
  panel.querySelector('.detail__left').focus({ preventScroll: true });

  panel.querySelector('.detail__back').addEventListener('click', closeDetail);

  panel.querySelector('.detail__play-all').addEventListener('click', () => {
    player.loadAlbum(album, tracks, 0);
  });

  panel.querySelector('.detail__edit').addEventListener('click', () => {
    showEditModal(album);
  });

  // Favourite star
  panel.querySelector('.detail__fav').addEventListener('click', async e => {
    album.favourite = !album.favourite;
    e.currentTarget.classList.toggle('is-fav', album.favourite);
    await updateAlbumField(album.id, { favourite: album.favourite });
    document.dispatchEvent(new CustomEvent('album-updated', { detail: album }));
  });

  panel.querySelector('#tracklist-body').addEventListener('click', e => {
    const row = e.target.closest('.tracklist__row');
    if (!row) return;
    const idx = parseInt(row.dataset.index, 10);
    setNavIndex(idx);
    player.loadAlbum(album, tracks, idx);
  });

  panel.querySelector('#tracklist-body').addEventListener('contextmenu', async e => {
    e.preventDefault();
    const row = e.target.closest('.tracklist__row');
    if (!row) return;
    const file = tracks[parseInt(row.dataset.index, 10)];
    if (!file) return;

    const menu = document.getElementById('context-menu');
    menu.innerHTML = `<button data-action="copy-track-path">${ICON_COPY_PATH} Copy path</button>`;
    menu.classList.remove('hidden');
    const pad = 8, mw = 180, mh = 48;
    menu.style.left = `${Math.min(e.clientX, window.innerWidth  - mw - pad)}px`;
    menu.style.top  = `${Math.min(e.clientY, window.innerHeight - mh - pad)}px`;

    function onTrackMenu(ev) {
      const btn = ev.target.closest('button[data-action]');
      menu.classList.add('hidden');
      menu.removeEventListener('click', onTrackMenu);
      if (btn?.dataset.action === 'copy-track-path') copyTrackFilePath(file);
    }
    menu.addEventListener('click', onTrackMenu);
    setTimeout(() => document.addEventListener('click', () => {
      menu.classList.add('hidden');
      menu.removeEventListener('click', onTrackMenu);
    }, { once: true }), 0);
  });

  player.addEventListener('trackchange', updateTrackHighlight);
  player.addEventListener('statechange', updateTrackHighlight);
}

function closeDetail() {
  const panel = document.getElementById('detail-panel');
  panel.classList.add('hidden');
  player.removeEventListener('trackchange', updateTrackHighlight);
  player.removeEventListener('statechange', updateTrackHighlight);
  _galleryUrls.forEach(u => URL.revokeObjectURL(u));
  _galleryUrls   = [];
  _currentAlbum  = null;
  _currentTracks = [];
}

function updateTrackHighlight() {
  document.querySelectorAll('.tracklist__row').forEach(row => {
    const idx    = parseInt(row.dataset.index, 10);
    const isThis = player.queueAlbum?.id === _currentAlbum?.id;
    row.classList.toggle('is-playing', isThis && idx === player.currentIndex && player.isPlaying);
    row.classList.toggle('is-current',  isThis && idx === player.currentIndex);
  });
}

document.addEventListener('keydown', e => {
  const panel = document.getElementById('detail-panel');
  if (panel.classList.contains('hidden')) return;

  const n = _currentTracks.length;

  if (e.key === 'Escape') {
    closeDetail();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (n > 0) setNavIndex((_navIndex + 1) % n);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (n > 0) setNavIndex((_navIndex - 1 + n) % n);
  } else if (e.key === 'Enter') {
    if (_currentAlbum && n > 0) {
      player.loadAlbum(_currentAlbum, _currentTracks, _navIndex);
    }
  }
});
