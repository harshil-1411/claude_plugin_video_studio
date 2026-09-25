/** Least-recently-used cache backed by a Map (insertion order = recency). */
export class LruCache {
  constructor({ max = 1000 } = {}) {
    this.max = max;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return this;
  }

  peek(key) {
    return this.map.get(key);
  }
}
