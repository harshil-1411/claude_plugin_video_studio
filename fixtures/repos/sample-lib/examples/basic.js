import { LruCache } from "../src/index.js";

const cache = new LruCache({ max: 2 });
cache.set("a", 1).set("b", 2).set("c", 3);
console.log(cache.get("a")); // undefined: "a" was evicted
