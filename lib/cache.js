'use strict';

class VersionCache {
  constructor(maxSize = 200) {
    this._cache = new Map();
    this._maxSize = maxSize;
    this._version = 0;
  }

  bump() { this._version++; }

  get(key) {
    const entry = this._cache.get(key);
    if (!entry || entry.version !== this._version) {
      this._cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    if (this._cache.size >= this._maxSize) {
      const first = this._cache.keys().next().value;
      this._cache.delete(first);
    }
    this._cache.set(key, { value, version: this._version });
  }

  clear() { this._cache.clear(); }
}

module.exports = { VersionCache };
