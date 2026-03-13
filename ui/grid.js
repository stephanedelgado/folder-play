/**
 * ui/grid.js
 * Album grid rendering, context menu, edit modal.
 */

import { player } from '../player.js';
import { putOverride, updateAlbumField, getPref } from '../db.js';
import { showDetail } from './detail.js';
import { showToast } from './toast.js';

// ── Lucide icons ──────────────────────────────────────────────────────────────

function lucide(paths, size = 14) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

const L = {
  play:      lucide(`<polygon points="5 3 19 12 5 21 5 3"/>`),
  squarePen: lucide(`<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>`),
  penTool:   lucide(`<path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="m2 2 7.586 7.586"/><circle cx="11" cy="11" r="2"/>`),
  scanEye:   lucide(`<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="1"/><path d="M5 12s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/>`),
  star:      lucide(`<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`),
};

const STAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

// ── Placeholder (grey + missing-image icon) ───────────────────────────────────

const MISSING_IMAGE_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <polyline points="21 15 16 10 5 21"/>
  </svg>`;

function placeholderHtml() {
  return `<div class="album-tile__placeholder">${MISSING_IMAGE_SVG}</div>`;
}

// ── Tile rendering ────────────────────────────────────────────────────────────

function renderTile(album) {
  const div = document.createElement('div');
  div.className = 'album-tile';
  div.dataset.id = album.id;

  const isPlayingThis = player.isPlaying && player.queueAlbum?.id === album.id;
  const playBtnClass  = isPlayingThis ? 'album-tile__play-btn is-visible' : 'album-tile__play-btn';

  const coverHtml = album.cover
    ? `<img class="album-tile__cover" src="${album.cover}" alt="" loading="lazy">`
    : placeholderHtml();

  div.innerHTML = `
    <div class="album-tile__art">
      ${coverHtml}
      <button class="${playBtnClass}" aria-label="Play/Pause">
        <span class="play-icon">
          <svg viewBox="0 0 24 24" fill="white" width="36" height="36"><polygon points="5,3 19,12 5,21"/></svg>
        </span>
        <span class="pause-icon">
          <svg viewBox="0 0 24 24" fill="white" width="36" height="36"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </span>
      </button>
      <button class="album-tile__fav ${album.favourite ? 'is-fav' : ''}" title="Toggle favourite" aria-label="Favourite">${STAR_SVG}</button>
    </div>
    <div class="album-tile__info">
      <div class="album-tile__footer">
        <span class="album-tile__artist" title="${escHtml(album.artist)}">${escHtml(album.artist)}</span>
        ${album.format ? `<span class="album-tile__format">${escHtml(album.format)}</span>` : ''}
      </div>
      <div class="album-tile__title" title="${escHtml(album.title)}">${escHtml(album.title)}</div>
    </div>
  `;

  // Update play-icon state
  syncPlayState(div, album);

  // Click on art (not play btn or fav) → detail view
  div.querySelector('.album-tile__art').addEventListener('click', e => {
    if (e.target.closest('.album-tile__play-btn') || e.target.closest('.album-tile__fav')) return;
    showDetail(album);
  });
  div.querySelector('.album-tile__info').addEventListener('click', () => showDetail(album));

  // Play/pause button
  div.querySelector('.album-tile__play-btn').addEventListener('click', e => {
    e.stopPropagation();
    if (player.queueAlbum?.id === album.id) {
      player.togglePlayPause();
    } else {
      player.loadAlbum(album, album.audioFiles || [], 0);
    }
  });

  // Favourite star
  div.querySelector('.album-tile__fav').addEventListener('click', async e => {
    e.stopPropagation();
    album.favourite = !album.favourite;
    e.currentTarget.classList.toggle('is-fav', album.favourite);
    await updateAlbumField(album.id, { favourite: album.favourite });
    document.dispatchEvent(new CustomEvent('album-updated', { detail: album }));
  });

  // Right-click context menu
  div.addEventListener('contextmenu', e => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, album);
  });

  return div;
}

function syncPlayState(tile, album) {
  const isThis    = player.queueAlbum?.id === album.id;
  const isPlaying = isThis && player.isPlaying;
  const isPaused  = isThis && !player.isPlaying;
  tile.classList.toggle('is-playing-album', isPlaying);
  tile.classList.toggle('is-paused-album', isPaused);
  // Keep button visible while this album is loaded (playing or paused)
  tile.querySelector('.album-tile__play-btn')?.classList.toggle('is-visible', isThis);
}

// Refresh play state on all tiles when player changes
function refreshAllPlayStates() {
  document.querySelectorAll('.album-tile').forEach(tile => {
    const id = tile.dataset.id;
    // Find album from data-id — we don't need the full object, just the id match
    const isThis    = player.queueAlbum?.id === id;
    const isPlaying = isThis && player.isPlaying;
    const isPaused  = isThis && !player.isPlaying;
    tile.classList.toggle('is-playing-album', isPlaying);
    tile.classList.toggle('is-paused-album', isPaused);
    tile.querySelector('.album-tile__play-btn')?.classList.toggle('is-visible', isThis);
  });
}

player.addEventListener('statechange', refreshAllPlayStates);
player.addEventListener('trackchange', refreshAllPlayStates);

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Grid rendering ────────────────────────────────────────────────────────────

export function renderGrid(albums) {
  const grid  = document.getElementById('album-grid');
  const count = document.getElementById('album-count');
  grid.innerHTML = '';
  count.textContent = `${albums.length} album${albums.length !== 1 ? 's' : ''}`;

  if (albums.length === 0) {
    grid.innerHTML = `<div class="empty-state">No albums match the current filters.</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for (const album of albums) frag.appendChild(renderTile(album));
  grid.appendChild(frag);
}

export function updateTile(album) {
  const existing = document.querySelector(`.album-tile[data-id="${CSS.escape(album.id)}"]`);
  if (existing) existing.replaceWith(renderTile(album));
}

// ── Context menu ──────────────────────────────────────────────────────────────

let _activeMenu = null;

export function showContextMenu(x, y, album) {
  hideContextMenu();

  const menu = document.getElementById('context-menu');
  menu.innerHTML = `
    <button data-action="play">${L.play} Play now</button>
    <button data-action="edit">${L.squarePen} Edit metadata</button>
    <button data-action="copy-path">${L.penTool} Copy path</button>
    <button data-action="rescan">${L.scanEye} Rescan this album</button>
    <button data-action="fav">${L.star} ${album.favourite ? 'Unfavourite' : 'Favourite'}</button>
  `;
  menu.classList.remove('hidden');

  const pad = 8, mw = 220, mh = 180;
  menu.style.left = `${Math.min(x, window.innerWidth  - mw - pad)}px`;
  menu.style.top  = `${Math.min(y, window.innerHeight - mh - pad)}px`;

  _activeMenu = album;
  menu.addEventListener('click', onMenuClick);
  setTimeout(() => document.addEventListener('click', hideContextMenu, { once: true }), 0);
}

async function onMenuClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const album = _activeMenu;
  hideContextMenu();

  switch (btn.dataset.action) {
    case 'play':
      player.loadAlbum(album, album.audioFiles || [], 0);
      break;

    case 'edit':
      showEditModal(album);
      break;

    case 'copy-path': {
      const root = await getPref('musicRoot', '');
      let path = album.folderPath;
      if (root) {
        // Strip the first path component (dropped folder name) and prepend root
        const rel = album.folderPath.split('/').slice(1).join('/');
        path = rel ? `${root}/${rel}` : root;
      }
      navigator.clipboard.writeText(path).then(() => {
        showToast(`Path copied \u2014 press \u2318\u21E7G in Finder to navigate`);
      });
      break;
    }

    case 'rescan':
      document.dispatchEvent(new CustomEvent('rescan-album', { detail: album }));
      break;

    case 'fav':
      album.favourite = !album.favourite;
      updateAlbumField(album.id, { favourite: album.favourite });
      updateTile(album);
      document.dispatchEvent(new CustomEvent('album-updated', { detail: album }));
      break;
  }
}

function hideContextMenu() {
  const menu = document.getElementById('context-menu');
  menu.classList.add('hidden');
  menu.removeEventListener('click', onMenuClick);
  _activeMenu = null;
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const menu = document.getElementById('context-menu');
    if (!menu.classList.contains('hidden')) hideContextMenu();
  }
});

// ── Edit modal ────────────────────────────────────────────────────────────────

let _editAlbum = null;

export function showEditModal(album) {
  _editAlbum = album;
  document.getElementById('edit-title').value  = album.title;
  document.getElementById('edit-artist').value = album.artist;
  document.getElementById('edit-year').value   = album.year || '';
  document.getElementById('edit-modal').classList.remove('hidden');
  document.getElementById('edit-title').focus();
}

function setupEditModal() {
  document.getElementById('edit-cancel-btn').addEventListener('click', () => {
    document.getElementById('edit-modal').classList.add('hidden');
  });

  document.getElementById('edit-save-btn').addEventListener('click', async () => {
    if (!_editAlbum) return;
    const fields = {
      title:  document.getElementById('edit-title').value.trim(),
      artist: document.getElementById('edit-artist').value.trim(),
      year:   document.getElementById('edit-year').value.trim(),
    };
    Object.assign(_editAlbum, fields);
    await putOverride(_editAlbum.id, fields);
    await updateAlbumField(_editAlbum.id, fields);
    updateTile(_editAlbum);
    document.dispatchEvent(new CustomEvent('album-updated', { detail: _editAlbum }));
    document.getElementById('edit-modal').classList.add('hidden');
    showToast('Album info saved');
  });

  document.querySelector('.modal__backdrop').addEventListener('click', () => {
    document.getElementById('edit-modal').classList.add('hidden');
  });

  document.getElementById('edit-modal').addEventListener('keydown', e => {
    if (e.key === 'Escape') document.getElementById('edit-modal').classList.add('hidden');
    if (e.key === 'Enter')  document.getElementById('edit-save-btn').click();
  });
}

setupEditModal();
