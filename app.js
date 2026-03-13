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
let _fileMap   = new Map(); // id → { audioFiles, imageFiles }  (legacy fallback)
let _dirHandle = null;      // FileSystemDirectoryHandle — enables live filesystem rescan

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
      if (ov.title)              album.title  = ov.title;
      if (ov.artist)             album.artist = ov.artist;
      if (ov.year !== undefined) album.year   = ov.year;
    }

    // Preserve favourite / playCount from previous in-memory state
    const prev = _allAlbums.find(a => a.id === album.id);
    if (prev) {
      album.favourite = prev.favourite ?? album.favourite;
      album.playCount = prev.playCount ?? album.playCount;
      album.addedAt   = prev.addedAt   ?? album.addedAt;
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

// ── FileSystemDirectoryHandle helpers ─────────────────────────────────────────

/**
 * Recursively enumerate all files under a FileSystemDirectoryHandle.
 * Each File object gets a `webkitRelativePath` set to `basePath/filename`
 * so the rest of the pipeline (groupByAlbum, etc.) works unchanged.
 */
async function getAllFilesFromHandle(dirHandle, basePath) {
  const files = [];
  for await (const [name, entry] of dirHandle.entries()) {
    const filePath = `${basePath}/${name}`;
    if (entry.kind === 'file') {
      // getFile() reads CURRENT state from disk — this is the key difference
      // from the legacy File objects which are fixed at drop time.
      const file = await entry.getFile();
      Object.defineProperty(file, 'webkitRelativePath', { value: filePath, writable: false });
      files.push(file);
    } else if (entry.kind === 'directory') {
      const sub = await getAllFilesFromHandle(entry, filePath);
      files.push(...sub);
    }
  }
  return files;
}

/**
 * Navigate from the root handle down to the subdirectory identified by folderPath.
 * folderPath looks like "RootDirName/Artist/Album".
 * The first component is the root handle's own name, so we skip it.
 */
async function getSubdirHandle(rootHandle, folderPath) {
  const parts = folderPath.split('/').slice(1); // skip root dir name
  let handle = rootHandle;
  for (const part of parts) {
    handle = await handle.getDirectoryHandle(part);
  }
  return handle;
}

/**
 * Ensure the stored directory handle has read permission.
 * In a drop event permission is automatic; on a subsequent rescan the
 * browser may require re-prompting.
 */
async function ensurePermission(handle) {
  const perm = await handle.queryPermission({ mode: 'read' });
  if (perm === 'granted') return true;
  const result = await handle.requestPermission({ mode: 'read' });
  return result === 'granted';
}

// ── Full rescan via FileSystemDirectoryHandle ─────────────────────────────────

async function rescanFromHandle() {
  if (!await ensurePermission(_dirHandle)) {
    showToast('Permission denied — re-drop your folder');
    return;
  }
  showToast('Reading filesystem…');
  const files = await getAllFilesFromHandle(_dirHandle, _dirHandle.name);
  await scanFiles(files);
}

// ── Full rescan via legacy in-memory File objects ─────────────────────────────

async function rescanFromMemory() {
  const overrides   = await getAllOverrides();
  const overrideMap = new Map(overrides.map(o => [o.id, o]));

  const entries = [..._fileMap.entries()];
  showProgress(`Rescanning ${entries.length} album${entries.length !== 1 ? 's' : ''}…`);

  let count = 0;
  for (const [id, fileGroup] of entries) {
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

// ── Single-album rescan via FileSystemDirectoryHandle ────────────────────────

async function rescanAlbumFromHandle(album) {
  if (!await ensurePermission(_dirHandle)) {
    showToast('Permission denied — re-drop your folder');
    return;
  }

  // Navigate to the album's own directory within the stored root handle.
  // This re-enumerates the directory from disk, picking up any new files
  // (cover.jpg added after the initial drop, newly embedded art, etc.).
  const albumDirHandle = await getSubdirHandle(_dirHandle, album.folderPath);
  const files = await getAllFilesFromHandle(albumDirHandle, album.folderPath);

  const albumMap = groupByAlbum(files);
  if (albumMap.size === 0) {
    showToast('No audio files found in album folder');
    return;
  }

  const overrides   = await getAllOverrides();
  const overrideMap = new Map(overrides.map(o => [o.id, o]));

  for await (const { album: fresh } of scanAlbums(albumMap)) {
    const ov = overrideMap.get(fresh.id);
    if (ov) {
      if (ov.title)              fresh.title  = ov.title;
      if (ov.artist)             fresh.artist = ov.artist;
      if (ov.year !== undefined) fresh.year   = ov.year;
    }

    // Preserve user state
    fresh.favourite = album.favourite;
    fresh.playCount = album.playCount;
    fresh.addedAt   = album.addedAt;

    // Update file map with fresh File objects so future operations use them
    _fileMap.set(fresh.id, { audioFiles: fresh.audioFiles, imageFiles: fresh.imageFiles });

    const idx = _allAlbums.findIndex(a => a.id === fresh.id);
    if (idx >= 0) _allAlbums[idx] = fresh;

    await putAlbum(fresh);
    updateTile(fresh);
  }

  showToast('Album rescanned');
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

    // Prefer File System Access API: gives us a live directory handle we can
    // use on future rescans to re-read the filesystem.
    if (items[0].getAsFileSystemHandle) {
      try {
        const handle = await items[0].getAsFileSystemHandle();
        if (handle.kind === 'directory') {
          _dirHandle = handle;
          showLibraryView();
          const files = await getAllFilesFromHandle(handle, handle.name);
          await scanFiles(files);
          return;
        }
      } catch (err) {
        console.warn('getAsFileSystemHandle failed, falling back:', err);
      }
    }

    // Legacy fallback
    const files = items[0].webkitGetAsEntry
      ? await getAllFilesFromDataTransfer(e.dataTransfer)
      : [...e.dataTransfer.files];
    if (!files.length) return;
    showLibraryView();
    await scanFiles(files);
  });

  // Folder picker: use showDirectoryPicker() when available so we get a handle
  document.getElementById('folder-picker-btn').addEventListener('click', async () => {
    if (window.showDirectoryPicker) {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        _dirHandle = handle;
        showLibraryView();
        const files = await getAllFilesFromHandle(handle, handle.name);
        await scanFiles(files);
      } catch (err) {
        if (err.name !== 'AbortError') console.error('showDirectoryPicker:', err);
      }
    } else {
      document.getElementById('folder-input').click();
    }
  });

  // Legacy <input> fallback (no directory handle available)
  document.getElementById('folder-input').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    _dirHandle = null; // no handle available from input element
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
    if (_dirHandle) {
      await rescanFromHandle();
    } else if (_fileMap.size > 0) {
      await rescanFromMemory();
    } else {
      // Nothing in memory — ask user to re-pick
      document.getElementById('folder-picker-btn').click();
    }
  });

  document.getElementById('clear-library-btn').addEventListener('click', async () => {
    if (!confirm('Clear all library data?')) return;
    await clearAll();
    _allAlbums = [];
    _fileMap.clear();
    _dirHandle = null;
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
    const val = input.value.trim().replace(/\/$/, '');
    input.value = val;
    await setPref('musicRoot', val);
  });
}

// ── Rescan single album ───────────────────────────────────────────────────────

document.addEventListener('rescan-album', async e => {
  const album = e.detail;

  // Primary path: re-read the album directory from the live filesystem handle.
  if (_dirHandle) {
    try {
      await rescanAlbumFromHandle(album);
    } catch (err) {
      console.error('rescanAlbumFromHandle failed:', err);
      showToast('Rescan failed — try re-dropping your folder');
    }
    return;
  }

  // Legacy fallback: use in-memory File objects from the original drop.
  // NOTE: this cannot pick up files added to disk after the initial drop.
  const fileGroup = _fileMap.get(album.id);
  if (!fileGroup) {
    showToast('Re-drop your music folder to rescan');
    return;
  }

  const overrides   = await getAllOverrides();
  const overrideMap = new Map(overrides.map(o => [o.id, o]));
  const fakeMap     = new Map([[album.id, fileGroup]]);

  for await (const { album: fresh } of scanAlbums(fakeMap)) {
    const ov = overrideMap.get(fresh.id);
    if (ov) {
      if (ov.title)              fresh.title  = ov.title;
      if (ov.artist)             fresh.artist = ov.artist;
      if (ov.year !== undefined) fresh.year   = ov.year;
    }
    fresh.favourite = album.favourite;
    fresh.playCount = album.playCount;
    fresh.addedAt   = album.addedAt;
    _fileMap.set(fresh.id, { audioFiles: fresh.audioFiles, imageFiles: fresh.imageFiles });
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
