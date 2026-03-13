/**
 * ui/detail.js
 * Full-screen album detail: tracklist on left, cover + info on right.
 */

import { player } from '../player.js';
import { showEditModal } from './grid.js';
import { IMAGE_EXTS } from '../scanner.js';
import { updateAlbumField } from '../db.js';

function ext(name) { return name.slice(name.lastIndexOf('.') + 1).toLowerCase(); }
function escHtml(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function displayName(filename) {
  return filename.replace(/\.[^.]+$/, '').replace(/^\d+[\s._\-]+/, '');
}

const MISSING_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <polyline points="21 15 16 10 5 21"/>
  </svg>`;

let _currentAlbum = null;

export function showDetail(album) {
  _currentAlbum = album;
  const panel = document.getElementById('detail-panel');

  const tracks = [...(album.audioFiles || [])].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true })
  );

  const images = [...(album.imageFiles || [])].filter(f => IMAGE_EXTS.has(ext(f.name)));

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
      <div class="detail__left">
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
          <button class="detail__fav ${album.favourite ? 'is-fav' : ''}" title="Toggle favourite" aria-label="Favourite">★</button>
        </div>
        <div class="detail__actions">
          <button class="btn btn--primary detail__play-all">&#9654;&#xFE0E; Play all</button>
          <button class="btn btn--ghost detail__edit">&#9998; Edit</button>
        </div>
        ${images.length > 1 ? `
        <div class="detail__gallery">
          ${images.map(f => `<img class="gallery-thumb" src="${URL.createObjectURL(f)}" alt="${escHtml(f.name)}" loading="lazy">`).join('')}
        </div>` : ''}
      </div>
    </div>
  `;

  panel.classList.remove('hidden');

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
    player.loadAlbum(album, tracks, parseInt(row.dataset.index, 10));
  });

  updateTrackHighlight();
  player.addEventListener('trackchange', updateTrackHighlight);
  player.addEventListener('statechange', updateTrackHighlight);
}

function closeDetail() {
  const panel = document.getElementById('detail-panel');
  panel.classList.add('hidden');
  player.removeEventListener('trackchange', updateTrackHighlight);
  player.removeEventListener('statechange', updateTrackHighlight);
  _currentAlbum = null;
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
  if (e.key === 'Escape') {
    const panel = document.getElementById('detail-panel');
    if (!panel.classList.contains('hidden')) closeDetail();
  }
});
