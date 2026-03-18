/**
 * scanner.js
 * Directory traversal, cover art detection, metadata extraction, health scoring.
 */

export const AUDIO_EXTS = new Set(['mp3','flac','ogg','m4a','aac','wav','opus','ape','wv']);
export const IMAGE_EXTS = new Set(['jpg','jpeg','png','webp','gif','bmp']);

// Only "cover" and "front" are preferred names (case-insensitive, before extension)
const PREFERRED_COVER = /^(cover|front)\./i;

// ── Helpers ───────────────────────────────────────────────────────────────────

function ext(name) {
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase();
}

function isAudio(name) { return AUDIO_EXTS.has(ext(name)); }
function isImage(name) { return IMAGE_EXTS.has(ext(name)); }

/**
 * Group a flat FileList by album directory.
 * Images in sub-folders (e.g. Scans/) are assigned upward to the nearest
 * parent folder that contains audio files.
 */
export function groupByAlbum(files) {
  const map = new Map(); // folderPath → { audioFiles[], imageFiles[] }

  // Pass 1: identify album folders (any folder that directly contains audio)
  for (const file of files) {
    if (!isAudio(file.name)) continue;
    const parts = file.webkitRelativePath.split('/');
    const albumPath = parts.slice(0, -1).join('/');
    if (!map.has(albumPath)) map.set(albumPath, { audioFiles: [], imageFiles: [] });
    map.get(albumPath).audioFiles.push(file);
  }

  // Pass 2: assign every image to the nearest ancestor album folder
  for (const file of files) {
    if (!isImage(file.name)) continue;
    const parts = file.webkitRelativePath.split('/');
    // Start at the image's own directory, walk up until we find an album entry
    let dir = parts.slice(0, -1).join('/');
    while (dir) {
      if (map.has(dir)) {
        map.get(dir).imageFiles.push(file);
        break;
      }
      const slash = dir.lastIndexOf('/');
      dir = slash === -1 ? '' : dir.slice(0, slash);
    }
    // If no album ancestor found (image at root level), add to any album whose
    // path starts with the same root — skip, we can't associate it usefully.
  }

  return map;
}

// ── Tag reading ───────────────────────────────────────────────────────────────

async function readAudioBuffer(file, maxBytes = 512 * 1024) {
  return new Uint8Array(await file.slice(0, maxBytes).arrayBuffer());
}

/**
 * Read exactly the bytes that make up the complete ID3v2 tag for an MP3.
 * The 10-byte ID3v2 header encodes the full tag body size in syncsafe
 * integers at bytes 6–9. We read that first, then read the declared size.
 * Returns null if the file has no ID3v2 header.
 */
async function readFullID3v2(file) {
  const hdr = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (hdr[0] !== 0x49 || hdr[1] !== 0x44 || hdr[2] !== 0x33) return null;
  const tagBodySize = syncsafe(hdr, 6);
  const total = 10 + tagBodySize;
  return new Uint8Array(await file.slice(0, total).arrayBuffer());
}

/**
 * Read all FLAC metadata blocks (everything before the first audio frame).
 * Walks block headers sequentially — each header is 4 bytes — to find
 * where metadata ends, then does one final read of exactly that many bytes.
 * Returns null if the file is not a FLAC file.
 */
async function readFullFLACMeta(file) {
  // Read an initial chunk large enough for typical metadata.
  // If a block extends beyond it we'll re-read with the correct size.
  const INIT = 256 * 1024;
  let buf = new Uint8Array(await file.slice(0, Math.min(INIT, file.size)).arrayBuffer());
  if (buf[0] !== 0x66 || buf[1] !== 0x4C || buf[2] !== 0x61 || buf[3] !== 0x43) return null;

  let offset = 4; // skip "fLaC" signature
  while (offset + 4 <= buf.length) {
    const isLast    = (buf[offset] & 0x80) !== 0;
    const blockSize = (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
    const blockEnd  = offset + 4 + blockSize;

    if (isLast) {
      // If the final block goes beyond what we already read, fetch the rest.
      if (blockEnd > buf.length) {
        buf = new Uint8Array(await file.slice(0, blockEnd).arrayBuffer());
      }
      return buf.slice(0, blockEnd);
    }

    // If next block header is beyond our buffer, extend the read and retry.
    if (blockEnd + 4 > buf.length) {
      const need = Math.min(blockEnd + INIT, file.size);
      buf = new Uint8Array(await file.slice(0, need).arrayBuffer());
    }

    offset = blockEnd;
  }
  return buf;
}

function readUint32BE(buf, o) {
  return ((buf[o] << 24) | (buf[o+1] << 16) | (buf[o+2] << 8) | buf[o+3]) >>> 0;
}
function readUint32LE(buf, o) {
  return ((buf[o+3] << 24) | (buf[o+2] << 16) | (buf[o+1] << 8) | buf[o]) >>> 0;
}
function syncsafe(buf, o) {
  return ((buf[o] & 0x7f) << 21) | ((buf[o+1] & 0x7f) << 14) |
         ((buf[o+2] & 0x7f) <<  7) |  (buf[o+3] & 0x7f);
}

function decodeStr(bytes) {
  try { return new TextDecoder('utf-8').decode(bytes).replace(/\0/g,'').trim(); } catch { /**/ }
  return new TextDecoder('latin1').decode(bytes).replace(/\0/g,'').trim();
}

function parseID3v2(buf) {
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null;
  const version = buf[3];
  const flags   = buf[5];
  const tagSize  = syncsafe(buf, 6) + 10;
  const tags = {};
  let i = 10;

  if (flags & 0x40) {
    const extSize = version >= 4 ? syncsafe(buf, i) : readUint32BE(buf, i);
    i += extSize;
  }

  while (i + 10 < tagSize && i + 10 < buf.length) {
    const id = String.fromCharCode(buf[i], buf[i+1], buf[i+2], buf[i+3]);
    if (id === '\0\0\0\0') break;
    const size = version >= 4 ? syncsafe(buf, i+4) : readUint32BE(buf, i+4);
    if (size <= 0 || size > 2_000_000) break;
    const data = buf.slice(i + 10, i + 10 + size);
    i += 10 + size;

    if      (id === 'TIT2') tags.title       = decodeTextFrame(data);
    else if (id === 'TALB') tags.album       = decodeTextFrame(data);
    else if (id === 'TPE1') tags.artist      = decodeTextFrame(data);
    else if (id === 'TPE2') tags.albumArtist = decodeTextFrame(data);
    else if (id === 'TDRC' || id === 'TYER') tags.year = decodeTextFrame(data).slice(0,4);
    else if (id === 'TRCK') tags.track       = decodeTextFrame(data);
    else if (id === 'APIC' && !tags.picture) tags.picture = decodeAPIC(data);
  }
  return tags;
}

function decodeTextFrame(data) {
  if (!data.length) return '';
  const enc = data[0], content = data.slice(1);
  if (enc === 0) return new TextDecoder('latin1').decode(content).replace(/\0/g,'').trim();
  if (enc === 1) {
    const bom = (content[0] << 8) | content[1];
    return new TextDecoder(bom === 0xFFFE ? 'utf-16le' : 'utf-16be').decode(content).replace(/\0/g,'').trim();
  }
  if (enc === 2) return new TextDecoder('utf-16be').decode(content).replace(/\0/g,'').trim();
  return new TextDecoder('utf-8').decode(content).replace(/\0/g,'').trim();
}

function decodeAPIC(data) {
  if (data.length < 4) return null;
  const enc = data[0];
  let i = 1;
  while (i < data.length && data[i] !== 0) i++;
  const mime = new TextDecoder('latin1').decode(data.slice(1, i)) || 'image/jpeg';
  i += 2; // skip null + picture type
  const nullSize = (enc === 1 || enc === 2) ? 2 : 1;
  while (i + nullSize <= data.length) {
    if (nullSize === 2) { if (data[i]===0 && data[i+1]===0) { i+=2; break; } i+=2; }
    else                { if (data[i]===0) { i+=1; break; } i+=1; }
  }
  const imageData = data.slice(i);
  return imageData.length ? { mime, data: imageData } : null;
}

function parseFLAC(buf) {
  if (buf[0] !== 0x66 || buf[1] !== 0x4C || buf[2] !== 0x61 || buf[3] !== 0x43) return null;
  const tags = {};
  let i = 4;
  while (i < buf.length) {
    const blockHeader = buf[i];
    const isLast     = (blockHeader & 0x80) !== 0;
    const blockType  = blockHeader & 0x7f;
    const blockSize  = (buf[i+1] << 16) | (buf[i+2] << 8) | buf[i+3];
    i += 4;
    if (blockType === 4) {
      const vendorLen = readUint32LE(buf, i); i += 4 + vendorLen;
      const count     = readUint32LE(buf, i); i += 4;
      for (let c = 0; c < count && i < buf.length; c++) {
        const len = readUint32LE(buf, i); i += 4;
        const s   = new TextDecoder('utf-8').decode(buf.slice(i, i + len)); i += len;
        const eq  = s.indexOf('=');
        if (eq === -1) continue;
        const key = s.slice(0, eq).toUpperCase(), val = s.slice(eq+1).trim();
        if      (key === 'ALBUM')       tags.album       = val;
        else if (key === 'ARTIST')      tags.artist      = val;
        else if (key === 'ALBUMARTIST') tags.albumArtist = val;
        else if (key === 'DATE' || key === 'YEAR') tags.year = val.slice(0,4);
        else if (key === 'TITLE')       tags.title       = val;
        else if (key === 'TRACKNUMBER') tags.track       = val;
      }
    } else if (blockType === 6 && !tags.picture) {
      tags.picture = parseFLACPicture(buf.slice(i, i + blockSize));
    }
    i += blockSize;
    if (isLast) break;
  }
  return tags;
}

function parseFLACPicture(data) {
  if (data.length < 8) return null;
  let i = 4;
  const mimeLen = readUint32BE(data, i); i += 4;
  const mime    = new TextDecoder('latin1').decode(data.slice(i, i + mimeLen)); i += mimeLen;
  const descLen = readUint32BE(data, i); i += 4 + descLen + 16;
  const dataLen = readUint32BE(data, i); i += 4;
  return { mime: mime || 'image/jpeg', data: data.slice(i, i + dataLen) };
}

function parseMP4Tags(buf) {
  const tags = {};
  const text = new TextDecoder('latin1').decode(buf);
  function extractAtom(marker) {
    const idx = text.indexOf(marker);
    if (idx === -1) return null;
    const start = idx + marker.length + 12;
    if (start >= buf.length) return null;
    const len = readUint32BE(buf, idx + marker.length);
    if (len <= 0 || len > 4096) return null;
    return decodeStr(buf.slice(start, idx + marker.length + len));
  }
  tags.album       = extractAtom('\xa9alb') || '';
  tags.artist      = extractAtom('\xa9ART') || '';
  tags.albumArtist = extractAtom('aART')    || '';
  tags.year        = (extractAtom('\xa9day') || '').slice(0,4);
  tags.title       = extractAtom('\xa9nam') || '';
  return tags;
}

export async function extractTags(file) {
  try {
    const e = ext(file.name);
    const buf = await readAudioBuffer(file);
    if (e === 'mp3')              return parseID3v2(buf)   || {};
    if (e === 'flac')             return parseFLAC(buf)    || {};
    if (e === 'm4a' || e === 'aac') return parseMP4Tags(buf);
    return {};
  } catch (err) {
    console.warn('extractTags:', file.name, err);
    return {};
  }
}

// ── Cover art resolution ──────────────────────────────────────────────────────

function picToBlob(pic) {
  if (!pic?.data) return null;
  return URL.createObjectURL(new Blob([pic.data], { type: pic.mime || 'image/jpeg' }));
}

/**
 * Resolve cover art with the following priority:
 * 1. Embedded art in audio file (MP3/FLAC)
 * 2. cover.* or front.* in album root dir
 * 3. cover.* or front.* in ANY subfolder (all depths)
 * 4. Any image in album root — largest by size
 * 5. Any image in any subfolder — largest by size
 * 6. Placeholder (returns blobUrl: null)
 */
export async function resolveCover(folderPath, { audioFiles, imageFiles }) {
  const albumDepth = folderPath.split('/').length; // number of path components in album dir

  // 1. Embedded art — read the COMPLETE tag block for each file so that
  //    large cover images (which routinely exceed 512 KB) are not truncated.
  for (const file of audioFiles.slice(0, 3)) {
    const e = ext(file.name);
    if (e !== 'mp3' && e !== 'flac') continue;
    try {
      const buf = e === 'mp3' ? await readFullID3v2(file) : await readFullFLACMeta(file);
      if (!buf) continue;
      const tags = e === 'mp3' ? parseID3v2(buf) : parseFLAC(buf);
      if (tags?.picture) {
        const url = picToBlob(tags.picture);
        if (url) return { blobUrl: url, source: 'embedded' };
      }
    } catch { /**/ }
  }

  // Helper: depth of a file's directory relative to album root
  // albumDepth = parts in album path (e.g. Music/Artist/Album = 3)
  // file at Music/Artist/Album/cover.jpg → parts.length - 1 = 3 → depth 0 (root)
  // file at Music/Artist/Album/Scans/cover.jpg → parts.length - 1 = 4 → depth 1 (sub)
  const fileDepth = f => f.webkitRelativePath.split('/').length - 1 - albumDepth;

  const rootImages = imageFiles.filter(f => fileDepth(f) === 0);
  const subImages  = imageFiles.filter(f => fileDepth(f)  > 0);

  // 2. cover.* or front.* in album root
  const rootPreferred = rootImages.filter(f => PREFERRED_COVER.test(f.name));
  if (rootPreferred.length > 0)
    return { blobUrl: URL.createObjectURL(rootPreferred[0]), source: 'file' };

  // 3. cover.* or front.* in any subfolder (all levels)
  const subPreferred = subImages.filter(f => PREFERRED_COVER.test(f.name));
  if (subPreferred.length > 0)
    return { blobUrl: URL.createObjectURL(subPreferred[0]), source: 'file' };

  // 4. Any image in album root — largest
  if (rootImages.length > 0) {
    rootImages.sort((a, b) => b.size - a.size);
    return { blobUrl: URL.createObjectURL(rootImages[0]), source: 'file' };
  }

  // 5. Any image in any subfolder — largest
  if (subImages.length > 0) {
    subImages.sort((a, b) => b.size - a.size);
    return { blobUrl: URL.createObjectURL(subImages[0]), source: 'file' };
  }

  // 6. Placeholder
  return { blobUrl: null, source: 'placeholder' };
}

// ── Format detection ─────────────────────────────────────────────────────────

// Priority: highest quality first. m4a is an AAC container.
const FORMAT_PRIORITY = [
  ['flac', 'FLAC'], ['wav',  'WAV'],  ['aac',  'AAC'], ['m4a', 'AAC'],
  ['mp3',  'MP3'],  ['ogg',  'OGG'],  ['opus', 'OPUS'],
  ['wv',   'WV'],   ['ape',  'APE'],
];

export function detectFormat(audioFiles) {
  const exts = new Set(audioFiles.map(f => ext(f.name)));
  for (const [e, label] of FORMAT_PRIORITY) {
    if (exts.has(e)) return label;
  }
  return ext(audioFiles[0]?.name || '').toUpperCase();
}

// ── Health scoring ────────────────────────────────────────────────────────────

export function calcHealth({ hasCover, hasEmbeddedTags }) {
  if (!hasCover && !hasEmbeddedTags) return 'red';
  if (!hasCover || !hasEmbeddedTags) return 'yellow';
  return 'green';
}

// ── Year from path ────────────────────────────────────────────────────────────

function yearFromPath(path) {
  const m = path.match(/\b(19[0-9]{2}|20[0-9]{2})\b/);
  return m ? m[1] : '';
}

// ── Main scanner generator ────────────────────────────────────────────────────

export async function* scanAlbums(albumMap) {
  const entries = [...albumMap.entries()].filter(([, v]) => v.audioFiles.length > 0);

  for (let idx = 0; idx < entries.length; idx++) {
    const [folderPath, group] = entries[idx];
    const parts      = folderPath.split('/');
    const folderName = parts[parts.length - 1];
    const parentName = parts.length >= 2 ? parts[parts.length - 2] : '';

    const tags           = await extractTags(group.audioFiles[0]);
    const hasEmbeddedTags = !!(tags.album || tags.artist || tags.albumArtist);
    const albumTitle      = tags.album  || folderName;
    const artist          = tags.albumArtist || tags.artist || parentName || 'Unknown Artist';
    const year            = tags.year   || yearFromPath(folderPath);
    const format          = detectFormat(group.audioFiles);

    const { blobUrl, source: coverSource } = await resolveCover(folderPath, group);
    const hasCover = coverSource !== 'placeholder';
    const health   = calcHealth({ hasCover, hasEmbeddedTags });

    yield {
      album: {
        id: folderPath,
        folderPath,
        title: albumTitle,
        artist,
        year,
        trackCount:      group.audioFiles.length,
        audioFiles:      group.audioFiles,
        imageFiles:      group.imageFiles,
        cover:           blobUrl,
        coverSource,
        hasCover,
        hasEmbeddedTags,
        health,
        format,
        addedAt:  Date.now(),
        playCount: 0,
        favourite: false,
      },
      progress: (idx + 1) / entries.length,
    };
  }
}
