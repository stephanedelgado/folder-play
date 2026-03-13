/**
 * app.js
 * Bootstrap, folder drop/pick, sort/filter, zoom, music root path.
 */

import { openDB, getAllAlbums, putAlbum, clearAll, getAllOverrides,
         getPref, setPref, deleteAlbum } from './db.js';
import { groupByAlbum, scanAlbums } from './scanner.js';
import { renderGrid, updateTile } from './ui/grid.js';
import { showToast } from './ui/toast.js';

// ── State ─────────────────────────────────────────────────────────────────────

let _allAlbums = [];
let _fileMap   = new Map(); // id → { audioFiles, imageFiles }

let _sortMode     = 'az';
let _filterMode   = 'all';
let _healthFilter = 'all';

// ── Sort / filter / grid ──────────────────────────────────────────────────────

function sortAlbums(albums) {
  const list = [...albums];
  switch (_sortMode) {
    case 'az':    return list.sort((a, b) => a.title.localeCompare(b.title));
    case 'za':    return list.sort((a, b) => b.title.localeCompare(a.title));
    case 'plays': return list.sort((a, b) => (b.playCount || 0) - (a.playCount || 0));
    case 'added': return list.sort((a, b) => (b.addedAt   || 0) - (a.addedAt   || 0));
    case 'year':  return list.sort((a, b) => (b.year || '') < (a.year || '') ? -1 : 1);
    default:      return list;
  }
}

function filterAlbums(albums) {
  return albums.filter(a => {
    if (_filterMode   === 'favourites' && !a.favourite)                     return false;
    if (_healthFilter === 'no-cover'   &&  a.hasCover)                      return false;
    if (_healthFilter === 'no-tags'    &&  a.hasEmbeddedTags)               return false;
    if (_healthFilter === 'needs-both' && (a.hasCover || a.hasEmbeddedTags)) return false;
    return true;
  });
}

function refreshGrid() {
  renderGrid(filterAlbums(sortAlbums(_allAlbums)));
}

// ── Scan progress UI ──────────────────────────────────────────────────────────

function showProgress(label) {
  document.getElementById('scan-progress').classList.remove('hidden');
  document.getElementById('scan-progress-label').textContent = label;
  document.getElementById('scan-progress-fill').style.width = '0%';
}

function updateProgress(fraction, label) {
  document.getElementById('scan-progress-fill').style.width = `${Math.round(fraction * 100)}%`;
  if (label) document.getElementById('scan-progress-label').textContent = label;
}

function hideProgress() {
  document.getElementById('scan-progress').classList.add('hidden');
}

// ── File scanning ─────────────────────────────────────────────────────────────

async function scanFiles(fileList) {
  const albumMap = groupByAlbum(fileList);
  if (albumMap.size === 0) { showToast('No audio files found'); return; }

  const overrides   = await getAllOverrides();
  const overrideMap = new Map(overrides.map(o => [o.id, o]));

  showProgress(`Scanning ${albumMap.size} album${albumMap.size !== 1 ? 's' : ''}…`);

  const scannedIds = new Set();
  let count = 0;

  for await (const { album, progress } of scanAlbums(albumMap)) {
    scannedIds.add(album.id);

    // Merge user overrides
    const ov = overrideMap.get(album.id);
    if (ov) {
      if (ov.title)            album.title  = ov.title;
      if (ov.artist)           album.artist = ov.artist;
      if (ov.year !== undefined) album.year = ov.year;
    }

    // Preserve favourite / playCount from previous in-memory or IDB state
    const prev = _allAlbums.find(a => a.id === album.id);
    if (prev) {
      album.favourite  = prev.favourite  ?? album.favourite;
      album.playCount  = prev.playCount  ?? album.playCount;
      album.addedAt    = prev.addedAt    ?? album.addedAt;
    }

    _fileMap.set(album.id, { audioFiles: album.audioFiles, imageFiles: album.imageFiles });
    await putAlbum(album);

    const idx = _allAlbums.findIndex(a => a.id === album.id);
    if (idx >= 0) _allAlbums[idx] = album;
    else          _allAlbums.push(album);

    count++;
    updateProgress(progress, `Scanned ${count} / ${albumMap.size} albums…`);
  }

  // Delta sync: remove albums no longer present in the drop
  const stale = _allAlbums.filter(a => !scannedIds.has(a.id));
  for (const a of stale) {
    await deleteAlbum(a.id);
    _fileMap.delete(a.id);
  }
  _allAlbums = _allAlbums.filter(a => scannedIds.has(a.id));

  hideProgress();
  refreshGrid();
  showToast(`Scanned ${count} album${count !== 1 ? 's' : ''}`);
}

// ── Rescan all albums from in-memory file references ─────────────────────────

async function rescanFromMemory() {
  const overrides   = await getAllOverrides();
  const overrideMap = new Map(overrides.map(o => [o.id, o]));

  const entries = [..._fileMap.entries()];
  showProgress(`Rescanning ${entries.length} album${entries.length !== 1 ? 's' : ''}…`);

  let count = 0;
  for (const [id, fileGroup] of entries) {
    // Revoke stale cover blob URL so the waterfall runs fresh
    const staleAlbum = _allAlbums.find(a => a.id === id);
    if (staleAlbum?.cover) { try { URL.revokeObjectURL(staleAlbum.cover); } catch { /**/ } }

    const fakeMap = new Map([[id, fileGroup]]);

    for await (const { album: fresh } of scanAlbums(fakeMap)) {
      const ov = overrideMap.get(fresh.id);
      if (ov) {
        if (ov.title)              fresh.title  = ov.title;
        if (ov.artist)             fresh.artist = ov.artist;
        if (ov.year !== undefined) fresh.year   = ov.year;
      }
      const prev = _allAlbums.find(a => a.id === fresh.id);
      if (prev) {
        fresh.favourite = prev.favourite ?? fresh.favourite;
        fresh.playCount = prev.playCount ?? fresh.playCount;
        fresh.addedAt   = prev.addedAt   ?? fresh.addedAt;
      }
      _fileMap.set(fresh.id, { audioFiles: fresh.audioFiles, imageFiles: fresh.imageFiles });
      await putAlbum(fresh);
      const idx = _allAlbums.findIndex(a => a.id === fresh.id);
      if (idx >= 0) _allAlbums[idx] = fresh;
      else          _allAlbums.push(fresh);
      updateTile(fresh);
    }

    count++;
    updateProgress(count / entries.length, `Rescanned ${count} / ${entries.length} albums…`);
  }

  hideProgress();
  refreshGrid();
  showToast(`Rescanned ${count} album${count !== 1 ? 's' : ''}`);
}

// ── Drop zone / folder picker ─────────────────────────────────────────────────

function initDropZone() {
  const dropZone = document.getElementById('drop-zone');

  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', async e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const items = [...e.dataTransfer.items].filter(i => i.kind === 'file');
    if (!items.length) return;
    const files = items[0].webkitGetAsEntry
      ? await getAllFilesFromDataTransfer(e.dataTransfer)
      : [...e.dataTransfer.files];
    if (!files.length) return;
    showLibraryView();
    await scanFiles(files);
  });

  document.getElementById('folder-picker-btn').addEventListener('click', () => {
    document.getElementById('folder-input').click();
  });

  document.getElementById('folder-input').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    showLibraryView();
    await scanFiles(files);
  });
}

async function getAllFilesFromDataTransfer(dataTransfer) {
  const files   = [];
  const entries = [...dataTransfer.items].map(i => i.webkitGetAsEntry()).filter(Boolean);

  async function traverse(entry, path) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      Object.defineProperty(file, 'webkitRelativePath', {
        value: path ? `${path}/${file.name}` : file.name,
        writable: false,
      });
      files.push(file);
    } else if (entry.isDirectory) {
      const dirPath = path ? `${path}/${entry.name}` : entry.name;
      const reader  = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await traverse(child, dirPath);
      } while (batch.length > 0);
    }
  }

  for (const entry of entries) await traverse(entry, '');
  return files;
}

// ── View switching ────────────────────────────────────────────────────────────

function showLibraryView() {
  document.getElementById('drop-zone').classList.add('hidden');
  document.getElementById('library-view').classList.remove('hidden');
}

function showDropZone() {
  document.getElementById('drop-zone').classList.remove('hidden');
  document.getElementById('library-view').classList.add('hidden');
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function initToolbar() {
  const sortSel   = document.getElementById('sort-select');
  const filterSel = document.getElementById('filter-select');
  const healthSel = document.getElementById('health-filter-select');

  sortSel.addEventListener('change', async () => {
    _sortMode = sortSel.value;
    await setPref('sort', _sortMode);
    refreshGrid();
  });
  filterSel.addEventListener('change', async () => {
    _filterMode = filterSel.value;
    await setPref('filter', _filterMode);
    refreshGrid();
  });
  healthSel.addEventListener('change', async () => {
    _healthFilter = healthSel.value;
    await setPref('healthFilter', _healthFilter);
    refreshGrid();
  });

  document.getElementById('rescan-btn').addEventListener('click', async () => {
    if (_fileMap.size === 0) {
      // No files in memory (e.g. page was reloaded) — ask user to re-select
      document.getElementById('folder-input').click();
      return;
    }
    await rescanFromMemory();
  });

  document.getElementById('clear-library-btn').addEventListener('click', async () => {
    if (!confirm('Clear all library data?')) return;
    await clearAll();
    _allAlbums = [];
    _fileMap.clear();
    showDropZone();
    showToast('Library cleared');
  });
}

function initZoomSlider() {
  const slider = document.getElementById('zoom-slider');
  slider.addEventListener('input', () => {
    document.documentElement.style.setProperty('--tile-size', `${slider.value}px`);
  });
  slider.addEventListener('change', () => {
    setPref('zoom', parseInt(slider.value, 10));
  });
}

function initRootPathInput() {
  const input = document.getElementById('root-path-input');
  input.addEventListener('change', async () => {
    const val = input.value.trim().replace(/\/$/, ''); // strip trailing slash
    input.value = val;
    await setPref('musicRoot', val);
  });
}

// ── Rescan single album ───────────────────────────────────────────────────────

document.addEventListener('rescan-album', async e => {
  const album    = e.detail;
  const fileGroup = _fileMap.get(album.id);
  if (!fileGroup) {
    showToast('Re-drop your music folder to rescan');
    return;
  }
  // Revoke stale cover blob URL so the waterfall runs fresh
  if (album.cover) { try { URL.revokeObjectURL(album.cover); } catch { /**/ } }
  const fakeMap = new Map([[album.id, fileGroup]]);
  for await (const { album: fresh } of scanAlbums(fakeMap)) {
    fresh.favourite = album.favourite;
    fresh.playCount = album.playCount;
    fresh.addedAt   = album.addedAt;
    const idx = _allAlbums.findIndex(a => a.id === fresh.id);
    if (idx >= 0) _allAlbums[idx] = fresh;
    await putAlbum(fresh);
    updateTile(fresh);
  }
  showToast('Album rescanned');
});

// ── Album updated ─────────────────────────────────────────────────────────────

document.addEventListener('album-updated', e => {
  const album = e.detail;
  const idx   = _allAlbums.findIndex(a => a.id === album.id);
  if (idx >= 0) _allAlbums[idx] = album;
  refreshGrid();
});

// ── ⌘⇧G on hovered tile → copy path ─────────────────────────────────────────

document.addEventListener('keydown', async e => {
  if (!(e.metaKey && e.shiftKey && e.key === 'G')) return;
  const hovered = document.querySelector('.album-tile:hover');
  if (!hovered) return;
  const album = _allAlbums.find(a => a.id === hovered.dataset.id);
  if (!album) return;
  const root = await getPref('musicRoot', '');
  let path = album.folderPath;
  if (root) {
    const rel = album.folderPath.split('/').slice(1).join('/');
    path = rel ? `${root}/${rel}` : root;
  }
  navigator.clipboard.writeText(path).then(() => {
    showToast(`Path copied \u2014 press \u2318\u21E7G in Finder to navigate`);
  });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  await openDB();

  // Restore prefs
  _sortMode     = await getPref('sort',         'az');
  _filterMode   = await getPref('filter',       'all');
  _healthFilter = await getPref('healthFilter', 'all');
  const zoom      = await getPref('zoom',       200);
  const musicRoot = await getPref('musicRoot',  '');

  document.getElementById('sort-select').value          = _sortMode;
  document.getElementById('filter-select').value        = _filterMode;
  document.getElementById('health-filter-select').value = _healthFilter;
  document.getElementById('zoom-slider').value          = zoom;
  document.getElementById('root-path-input').value      = musicRoot;
  document.documentElement.style.setProperty('--tile-size', `${zoom}px`);

  // Load persisted albums (no File refs; cover URLs stale after reload)
  const saved = await getAllAlbums();
  if (saved.length > 0) {
    _allAlbums = saved;
    showLibraryView();
    refreshGrid();
    showToast('Library loaded — re-drop your folder to restore playback');
  }

  initDropZone();
  initToolbar();
  initZoomSlider();
  initRootPathInput();
}

init().catch(console.error);
