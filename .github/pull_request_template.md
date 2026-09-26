**What and why**

**How it was checked**
- [ ] `pnpm check` passes (typecheck, tests, bundle, smoke, plugin validation, golden frames)
- [ ] `dist/mcp.mjs` rebuilt and committed (for changes under `packages/`)
- [ ] `schemas/` regenerated (for zod changes)
- [ ] Tests added or updated for the change
- [ ] Skills / README updated if behaviour changed

**Rules** (see CONTRIBUTING.md)
- [ ] No platform numbers in code or skill text (they live in `platform-specs/`)
- [ ] Nothing heavy bundled or auto-installed; downloads and paid calls need user consent
