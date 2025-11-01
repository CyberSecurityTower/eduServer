/**
 * Simple LRUCache implementation with TTL (Time To Live)
 * Used for caching Firestore data or computed results.
 */

class LRUCache {
  constructor(limit = 500, ttl = 1000 * 60 * 60) { // default: 500 items, 1 hour TTL
    this.limit = limit;
    this.ttl = ttl;
    this.map = new Map();
  }

  _isExpired(entry) {
    return Date.now() > (entry.t + this.ttl);
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;

    // Remove if expired
    if (this._isExpired(entry)) {
      this.map.delete(key);
      return null;
    }

    // Move to most recently used
    this.map.delete(key);
    this.map.set(key, entry);

    return entry.v;
  }

  set(key, value) {
    // Remove existing entry
    if (this.map.has(key)) this.map.delete(key);

    // If full, remove oldest
    if (this.map.size >= this.limit) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }

    // Add new entry
    this.map.set(key, { v: value, t: Date.now() });
  }

  del(key) { this.map.delete(key); }
  clear() { this.map.clear(); }

  has(key) {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (this._isExpired(entry)) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  size() {
    return this.map.size;
  }
}

module.exports = LRUCache;
