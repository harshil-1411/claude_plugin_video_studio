---
title: Streaming uploads with Node.js
author: Dana Kim
tags: [node, streams]
date: 2026-08-14
---

# Streaming uploads with Node.js

Buffering a 2 GB upload in memory will crash a small container. Streams keep
memory flat at roughly 64 KB per request.

## Pipe the request

```js
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

export async function save(req, path) {
  await pipeline(req, createWriteStream(path));
}
```

## Limit the size

Reject bodies over 100 MB before writing anything to disk.
