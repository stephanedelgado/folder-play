/**
 * db.js
 * Thin IndexedDB wrapper.
 * Stores: albums, overrides, prefs
 */

const DB_NAME = 'music-player';
const DB_VERSION = 1;

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('albums')) {
        db.createObjectStore('albums', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('overrides')) {
        db.createObjectStore('overrides', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('prefs')) {
        db.createObjectStore('prefs', { keyPath: 'key' });
      }
    };

    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = e => reject(e.target.error);
  });
}

function tx(storeName, mode = 'readonly') {
  return _db.transaction(storeName, mode).objectStore(storeName);
}

function promisify(req) {
  return new Promise((res, rej) => {
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}

// ── Albums store ──────────────────────────────────────────────────────────────

export async function putAlbum(album) {
  await openDB();
  const record = { ...album };
  delete record.audioFiles;
  delete record.imageFiles;
  record.cover = null; // blob URLs are session-only; re-resolved on each drop
  return promisify(tx('albums', 'readwrite').put(record));
}

export async function getAlbum(id) {
  await openDB();
  return promisify(tx('albums').get(id));
}

export async function getAllAlbums() {
  await openDB();
  return promisify(tx('albums').getAll());
}

export async function deleteAlbum(id) {
  await openDB();
  return promisify(tx('albums', 'readwrite').delete(id));
}

export async function clearAlbums() {
  await openDB();
  return promisify(tx('albums', 'readwrite').clear());
}

export async function updateAlbumField(id, fields) {
  await openDB();
  // Get and put in one readwrite transaction to avoid a TOCTOU race and
  // the overhead of two separate transactions.
  return new Promise((resolve, reject) => {
    const store = tx('albums', 'readwrite');
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) { resolve(); return; }
      const putReq = store.put({ ...existing, ...fields });
      putReq.onsuccess = () => resolve(putReq.result);
      putReq.onerror  = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// ── Overrides store ───────────────────────────────────────────────────────────

export async function putOverride(id, fields) {
  await openDB();
  return promisify(tx('overrides', 'readwrite').put({ id, ...fields }));
}

export async function getOverride(id) {
  await openDB();
  return promisify(tx('overrides').get(id));
}

export async function getAllOverrides() {
  await openDB();
  return promisify(tx('overrides').getAll());
}

// ── Prefs store ───────────────────────────────────────────────────────────────

export async function getPref(key, defaultVal = null) {
  await openDB();
  const rec = await promisify(tx('prefs').get(key));
  return rec ? rec.value : defaultVal;
}

export async function setPref(key, value) {
  await openDB();
  return promisify(tx('prefs', 'readwrite').put({ key, value }));
}

export async function clearAll() {
  await openDB();
  const stores = ['albums', 'overrides', 'prefs'];
  return Promise.all(stores.map(s => promisify(tx(s, 'readwrite').clear())));
}
