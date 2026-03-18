/**
 * app.js
 * Bootstrap, folder drop/pick, sort/filter, zoom, music root path.
 */

import { openDB, getAllAlbums, putAlbum, clearAll, getAllOverrides,
         getPref, setPref, deleteAlbum } from './db.js';
import { groupByAlbum, scanAlbums } from './scanner.js';
import { renderGrid, updateTile } from './ui/grid.js';
import { showToast } from './ui/toast.js';
import { player } from './player.js';

// ── State ─────────────────────────────────────────────────────────────────────

let _allAlbums = [];
let _fileMap   = new Map(); // id → { audioFiles, imageFiles }  (legacy fallback)
let _dirHandle = null;      // FileSystemDirectoryHandle — root of the user's library

// Maps albumId → FileSystemDirectoryHandle for that album's directory.
// Populated during scan; used for isSameEntry() identity matching on rescan.
let _albumDirHandles = new Map();

// Populated fresh at the start of each getAllFilesFromHandle() enumeration.
// Maps folderPath → FileSystemDirectoryHandle for every directory encountered.
let _foundDirHandles = new Map();

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

function resetFilters() {
  _sortMode     = 'az';
  _filterMode   = 'all';
  _healthFilter = 'all';
  const sortSel   = document.getElementById('sort-select');
  const filterSel = document.getElementById('filter-select');
  const healthSel = document.getElementById('health-filter-select');
  if (sortSel)   sortSel.value   = _sortMode;
  if (filterSel) filterSel.value = _filterMode;
  if (healthSel) healthSel.value = _healthFilter;
  setPref('sort',         _sortMode);
  setPref('filter',       _filterMode);
  setPref('healthFilter', _healthFilter);
}

async function scanFiles(fileList) {
  resetFilters();
  const albumMap = groupByAlbum(fileList);
  if (albumMap.size === 0) { showToast('No audio files found'); return; }

  const overrides   = await getAllOverrides();
  const overrideMap = new Map(overrides.map(o => [o.id, o]));

  showProgress(`Scanning ${albumMap.size} album${albumMap.size !== 1 ? 's' : ''}…`);

  // scannedIds accumulates both new album ids AND the old ids of any renamed
  // albums, so that renamed albums are not treated as stale.
  const scannedIds = new Set();
  let count = 0;

  for await (const { album, progress } of scanAlbums(albumMap)) {
    const newDirHandle = _foundDirHandles.get(album.folderPath);

    // Identity-based matching: isSameEntry() returns true for the same filesystem
    // inode even if the folder was renamed. This is the authoritative check.
    const existingId = await findExistingAlbumByHandle(newDirHandle);

    let prev = null;
    if (existingId) {
      // Mark the OLD id as handled so it won't be flagged stale below.
      scannedIds.add(existingId);
      prev = _allAlbums.find(a => a.id === existingId);

      if (existingId !== album.id && prev) {
        // Folder was renamed — delete the old IDB record and remove from memory.
        // We will write a fresh record under the new id below.
        await deleteAlbum(existingId);
        _albumDirHandles.delete(existingId);
        const prevIdx = _allAlbums.findIndex(a => a.id === existingId);
        if (prevIdx >= 0) _allAlbums.splice(prevIdx, 1);
      }
    } else {
      // No identity match — check by current path id (new album or same path).
      prev = _allAlbums.find(a => a.id === album.id);
    }

    scannedIds.add(album.id);

    // Merge user overrides (try new id first, fall back to old id for renames).
    const ov = overrideMap.get(album.id) ?? overrideMap.get(existingId);
    if (ov) {
      if (ov.title)              album.title  = ov.title;
      if (ov.artist)             album.artist = ov.artist;
      if (ov.year !== undefined) album.year   = ov.year;
    }

    // Carry over user state from the previous record.
    if (prev) {
      album.favourite = prev.favourite ?? album.favourite;
      album.playCount = prev.playCount ?? album.playCount;
      album.addedAt   = prev.addedAt   ?? album.addedAt;
    }
    album.missing = false;

    // Store the directory handle so future rescans can match by identity.
    if (newDirHandle) _albumDirHandles.set(album.id, newDirHandle);

    _fileMap.set(album.id, { audioFiles: album.audioFiles, imageFiles: album.imageFiles });
    await putAlbum(album);

    const idx = _allAlbums.findIndex(a => a.id === album.id);
    if (idx >= 0) _allAlbums[idx] = album;
    else          _allAlbums.push(album);

    count++;
    updateProgress(progress, `Scanned ${count} / ${albumMap.size} albums…`);
  }

  // Albums not found in this scan → mark as missing, keep in grid.
  // No toast here: the toast fires when the user clicks the greyed tile.
  const stale = _allAlbums.filter(a => !scannedIds.has(a.id));
  for (const a of stale) {
    if (!a.missing) {
      a.missing = true;
      await putAlbum(a);
      updateTile(a);
    }
    _fileMap.delete(a.id);
  }
  // Keep found albums + missing ones; filter out nothing else.
  _allAlbums = _allAlbums.filter(a => scannedIds.has(a.id) || a.missing);

  hideProgress();
  refreshGrid();
  showToast(`Scanned ${count} album${count !== 1 ? 's' : ''}`);
}

// ── FileSystemDirectoryHandle helpers ─────────────────────────────────────────

/**
 * Recursively enumerate all files under a FileSystemDirectoryHandle.
 * As a side effect, populates _foundDirHandles with every directory encountered,
 * so scanFiles() can retrieve a handle by folderPath for isSameEntry() matching.
 */
async function getAllFilesFromHandle(dirHandle, basePath) {
  const files = [];
  for await (const [name, entry] of dirHandle.entries()) {
    const filePath = `${basePath}/${name}`;
    if (entry.kind === 'file') {
      const file = await entry.getFile();
      Object.defineProperty(file, 'webkitRelativePath', { value: filePath, writable: false });
      files.push(file);
    } else if (entry.kind === 'directory') {
      _foundDirHandles.set(filePath, entry);
      const sub = await getAllFilesFromHandle(entry, filePath);
      files.push(...sub);
    }
  }
  return files;
}

/**
 * Navigate from the root handle down to the subdirectory identified by folderPath.
 * The first path component is the root handle's own name and is skipped.
 */
async function getSubdirHandle(rootHandle, folderPath) {
  const parts = folderPath.split('/').slice(1);
  let handle = rootHandle;
  for (const part of parts) {
    handle = await handle.getDirectoryHandle(part);
  }
  return handle;
}

/**
 * Ensure the stored directory handle has read permission.
 */
async function ensurePermission(handle) {
  const perm = await handle.queryPermission({ mode: 'read' });
  if (perm === 'granted') return true;
  const result = await handle.requestPermission({ mode: 'read' });
  return result === 'granted';
}

/**
 * Check all stored album directory handles to see if any is the same
 * filesystem entry as newHandle (same inode, regardless of path).
 * Returns the album id of the matching stored entry, or null.
 */
async function findExistingAlbumByHandle(newHandle) {
  if (!newHandle) return null;
  for (const [albumId, storedHandle] of _albumDirHandles) {
    try {
      if (await newHandle.isSameEntry(storedHandle)) return albumId;
    } catch { /* handle may be stale — skip */ }
  }
  return null;
}

/**
 * DFS through the directory tree rooted at rootHandle to find a directory
 * that isSameEntry as targetHandle. Returns { handle, path } or null.
 * Used when a single-album rescan fails because the folder was renamed.
 */
async function findRenamedDirHandle(rootHandle, rootPath, targetHandle) {
  async function search(dirHandle, currentPath) {
    for await (const [name, entry] of dirHandle.entries()) {
      if (entry.kind !== 'directory') continue;
      const entryPath = `${currentPath}/${name}`;
      try {
        if (await entry.isSameEntry(targetHandle)) return { handle: entry, path: entryPath };
        const found = await search(entry, entryPath);
        if (found) return found;
      } catch { /* skip inaccessible entries */ }
    }
    return null;
  }
  return search(rootHandle, rootPath);
}

// ── Full rescan via FileSystemDirectoryHandle ─────────────────────────────────

async function rescanFromHandle() {
  if (!await ensurePermission(_dirHandle)) {
    showToast('Permission denied — re-drop your folder');
    return;
  }
  showToast('Reading filesystem…');
  _foundDirHandles.clear();
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

  let albumDirHandle  = null;
  let albumFolderPath = album.folderPath;

  // Try the known path first.
  try {
    albumDirHandle = await getSubdirHandle(_dirHandle, album.folderPath);
  } catch (err) {
    if (err.name !== 'NotFoundError') throw err;

    // Path not found — search for it by filesystem identity (isSameEntry).
    const storedHandle = _albumDirHandles.get(album.id);
    if (storedHandle) {
      const found = await findRenamedDirHandle(_dirHandle, _dirHandle.name, storedHandle);
      if (found) {
        albumDirHandle  = found.handle;
        albumFolderPath = found.path;
      }
    }
  }

  if (!albumDirHandle) {
    // Not found anywhere — mark missing and show the toast.
    if (!album.missing) {
      album.missing = true;
      const idx = _allAlbums.findIndex(a => a.id === album.id);
      if (idx >= 0) _allAlbums[idx] = album;
      await putAlbum(album);
      updateTile(album);
    }
    showToast('Folder not found — please rescan');
    return;
  }

  const files    = await getAllFilesFromHandle(albumDirHandle, albumFolderPath);
  const albumMap = groupByAlbum(files);
  if (albumMap.size === 0) { showToast('No audio files found in album folder'); return; }

  const overrides   = await getAllOverrides();
  const overrideMap = new Map(overrides.map(o => [o.id, o]));

  for await (const { album: fresh } of scanAlbums(albumMap)) {
    // If the folder was renamed, migrate the IDB record to the new id/path.
    if (fresh.id !== album.id) {
      await deleteAlbum(album.id);
      _albumDirHandles.delete(album.id);
      const oldIdx = _allAlbums.findIndex(a => a.id === album.id);
      if (oldIdx >= 0) _allAlbums.splice(oldIdx, 1);
    }

    const ov = overrideMap.get(album.id) ?? overrideMap.get(fresh.id);
    if (ov) {
      if (ov.title)              fresh.title  = ov.title;
      if (ov.artist)             fresh.artist = ov.artist;
      if (ov.year !== undefined) fresh.year   = ov.year;
    }

    fresh.favourite = album.favourite;
    fresh.playCount = album.playCount;
    fresh.addedAt   = album.addedAt;
    fresh.missing   = false;

    _fileMap.set(fresh.id, { audioFiles: fresh.audioFiles, imageFiles: fresh.imageFiles });
    _albumDirHandles.set(fresh.id, albumDirHandle);

    const idx = _allAlbums.findIndex(a => a.id === fresh.id);
    if (idx >= 0) _allAlbums[idx] = fresh;
    else          _allAlbums.push(fresh);

    await putAlbum(fresh);
  }

  // Re-render the whole grid to handle the case where the tile id changed.
  refreshGrid();
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

    if (items[0].getAsFileSystemHandle) {
      try {
        const handle = await items[0].getAsFileSystemHandle();
        if (handle.kind === 'directory') {
          _dirHandle = handle;
          showLibraryView();
          _foundDirHandles.clear();
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

  document.getElementById('folder-picker-btn').addEventListener('click', async () => {
    if (window.showDirectoryPicker) {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        _dirHandle = handle;
        showLibraryView();
        _foundDirHandles.clear();
        const files = await getAllFilesFromHandle(handle, handle.name);
        await scanFiles(files);
      } catch (err) {
        if (err.name !== 'AbortError') console.error('showDirectoryPicker:', err);
      }
    } else {
      document.getElementById('folder-input').click();
    }
  });

  document.getElementById('folder-input').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    _dirHandle = null;
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
      document.getElementById('folder-picker-btn').click();
    }
  });

  document.getElementById('clear-library-btn').addEventListener('click', async () => {
    if (!confirm('Clear all library data?')) return;
    await clearAll();
    _allAlbums = [];
    _fileMap.clear();
    _dirHandle = null;
    _albumDirHandles.clear();
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
