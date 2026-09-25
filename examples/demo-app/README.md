# Example: a tiny app to record with `/video-studio:demo`

A static page with stable selectors (`#start`, `#email`, `#go`, `#plan`). Serve it, then record:

```sh
cd examples/demo-app && python3 -m http.server 3000
```

```
/video-studio:demo record http://localhost:3000 in ~/vs-demo: click #start, type a dummy email into #email, click #go, zoom into #plan, scroll down. Use a 1080x1920 viewport.
```

At 1080×1920 the page lays out at phone width (390 CSS px) and records at full resolution.
