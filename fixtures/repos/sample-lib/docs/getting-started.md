# Getting started

Create a cache with a maximum size. The default size is 1,000 entries.

## Eviction

When the cache is full, the least recently used entry is removed first.
Eviction runs in constant time, O(1), using a doubly linked list and a Map.
