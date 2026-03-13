/**
 * player.js
 * Web Audio API playback engine.
 * Exports a singleton `player` object.
 */

import { updateAlbumField } from './db.js';

class MusicPlayer extends EventTarget {
  constructor() {
    super();
    this._ctx = null;
    this._sourceNode = null;
    this._gainNode = null;
    this._analyserNode = null;
    this._audioEl = null;

    this.queue = [];       // array of File objects
    this.queueAlbum = null;
    this.currentIndex = -1;
    this.isPlaying = false;
    this.volume = 1;
    this.currentTime = 0;
    this.duration = 0;

    this._setupAudioElement();
  }

  _setupAudioElement() {
    this._audioEl = new Audio();
    this._audioEl.preload = 'auto';
    this._audioEl.volume = this.volume;

    this._audioEl.addEventListener('timeupdate', () => {
      this.currentTime = this._audioEl.currentTime;
      this.duration = this._audioEl.duration || 0;
      this.dispatchEvent(new CustomEvent('timeupdate', {
        detail: { currentTime: this.currentTime, duration: this.duration }
      }));
    });

    this._audioEl.addEventListener('ended', () => {
      this.next();
    });

    this._audioEl.addEventListener('error', e => {
      console.error('Audio error', e);
      this.dispatchEvent(new CustomEvent('error', { detail: e }));
    });

    this._audioEl.addEventListener('play', () => {
      this.isPlaying = true;
      this.dispatchEvent(new Event('statechange'));
    });

    this._audioEl.addEventListener('pause', () => {
      this.isPlaying = false;
      this.dispatchEvent(new Event('statechange'));
    });

    this._audioEl.addEventListener('loadedmetadata', () => {
      this.duration = this._audioEl.duration || 0;
      this.dispatchEvent(new CustomEvent('trackloaded', {
        detail: { track: this.currentTrack(), index: this.currentIndex }
      }));
    });
  }

  _ensureContext() {
    if (!this._ctx) {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._gainNode = this._ctx.createGain();
      this._analyserNode = this._ctx.createAnalyser();
      this._analyserNode.fftSize = 2048;

      const source = this._ctx.createMediaElementSource(this._audioEl);
      source.connect(this._analyserNode);
      this._analyserNode.connect(this._gainNode);
      this._gainNode.connect(this._ctx.destination);
    }
    if (this._ctx.state === 'suspended') this._ctx.resume();
  }

  /** Load an album's track list and optionally start playing */
  loadAlbum(album, audioFiles, startIndex = 0) {
    this.queue = [...audioFiles].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    this.queueAlbum = album;
    this.currentIndex = -1;
    this.playAt(startIndex);
  }

  playAt(index) {
    if (index < 0 || index >= this.queue.length) return;
    this.currentIndex = index;
    const file = this.queue[index];
    const url = URL.createObjectURL(file);

    // Revoke previous blob URL
    if (this._currentBlobUrl) URL.revokeObjectURL(this._currentBlobUrl);
    this._currentBlobUrl = url;

    this._audioEl.src = url;
    this._ensureContext();
    this._audioEl.play().catch(e => console.warn('Playback error', e));

    this.dispatchEvent(new CustomEvent('trackchange', {
      detail: { track: file, index, album: this.queueAlbum }
    }));
  }

  play() {
    if (this.currentIndex === -1 && this.queue.length > 0) {
      this.playAt(0);
    } else {
      this._ensureContext();
      this._audioEl.play().catch(e => console.warn(e));
    }
  }

  pause() {
    this._audioEl.pause();
  }

  togglePlayPause() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  next() {
    const nextIdx = this.currentIndex + 1;
    if (nextIdx < this.queue.length) {
      this.playAt(nextIdx);
    } else {
      // End of queue — increment play count
      this._recordPlay();
      this.isPlaying = false;
      this.dispatchEvent(new Event('statechange'));
      this.dispatchEvent(new Event('queueend'));
    }
  }

  prev() {
    // If more than 3 seconds in, restart current track
    if (this._audioEl.currentTime > 3) {
      this._audioEl.currentTime = 0;
      return;
    }
    const prevIdx = this.currentIndex - 1;
    if (prevIdx >= 0) this.playAt(prevIdx);
  }

  seek(seconds) {
    this._audioEl.currentTime = seconds;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this._audioEl.volume = this.volume;
    if (this._gainNode) this._gainNode.gain.value = this.volume;
  }

  currentTrack() {
    return this.queue[this.currentIndex] || null;
  }

  /** Get frequency data for waveform visualisation */
  getFrequencyData() {
    if (!this._analyserNode) return null;
    const data = new Uint8Array(this._analyserNode.frequencyBinCount);
    this._analyserNode.getByteFrequencyData(data);
    return data;
  }

  getTimeDomainData() {
    if (!this._analyserNode) return null;
    const data = new Uint8Array(this._analyserNode.fftSize);
    this._analyserNode.getByteTimeDomainData(data);
    return data;
  }

  async _recordPlay() {
    if (!this.queueAlbum) return;
    const newCount = (this.queueAlbum.playCount || 0) + 1;
    this.queueAlbum.playCount = newCount;
    await updateAlbumField(this.queueAlbum.id, { playCount: newCount });
  }
}

export const player = new MusicPlayer();
