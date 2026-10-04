---
name: zotero-ops
description: Operations, build workflows, syncing, versioning, and release management for Zotero projects. Load when running builds, preparing releases, or troubleshooting deployment.
---

# Zotero Operations Skill

This skill provides operational guidance for the Zotero Hermes plugin project.

## Purpose

To ensure smooth build processes, proper versioning, and reliable releases.

## Scope

This skill covers:

- Build and deployment workflows
- Performance optimization
- Quick command reference
- Release checklist
- Security and privacy practices
- Testing strategies
- Troubleshooting

## Build Workflow

### Development

```bash
# Start development server with hot reload
npm start

# Build for testing
npm run build

# Run tests
npm test
```

### Release

Releases are **tag-driven through CI**. `.github/workflows/release.yml`
triggers on any pushed `v*` tag and calls the shared
`zotero-plugin-dev/workflows/.github/workflows/release-plugin.yml@main`,
which builds the plugin, runs `npm run release` (creates the GitHub release,
uploads `hermes-agent-for-zotero.xpi` + `update.json`) and posts the comment.

```bash
# 1. version + changelog on main
npm version patch --no-git-tag-version     # package.json + package-lock.json
#    promote CHANGELOG [Unreleased] -> [<ver>] — YYYY-MM-DD, then:
npx prettier --write CHANGELOG.md          # whole-repo prettier is the gate

# 2. gates (see Release Checklist) then commit + tag + push
git commit -m "release: v<x.y.z>"
git tag -a v<x.y.z> -m "Release v<x.y.z>"
git push origin main && git push origin v<x.y.z>
# 3. the tag push runs the release workflow — watch it
gh run list --workflow=release.yml --limit 1
```

**Do NOT run `gh release create` by hand.** The workflow creates the release
itself; a pre-existing release makes it fail with
`422 Validation Failed: already_exists` (field `tag_name`). If that happens,
delete only the release (`gh release delete <tag> --yes`, keeping the tag) and
re-run the workflow by re-pushing the tag:
`git push origin :refs/tags/<tag> && git push origin <tag>`.
The workflow has no `workflow_dispatch` trigger, so a tag re-push is the only
way to re-run it without a new commit.

Version note: `package.json` may already sit above the last tag (e.g. tagged
v0.3.2 but package at 0.3.3 — 0.3.3 was released without a tag). Compute the
bump from `package.json`, and note the tag you create may skip a number.

## Quick Reference

### Common Commands

| Command            | Purpose                    |
| ------------------ | -------------------------- |
| `npm start`        | Dev server with hot reload |
| `npm run build`    | Production build           |
| `npm test`         | Run test suite             |
| `npm run lint:fix` | Fix linting issues         |
| `npm run release`  | Create GitHub release      |

### File Locations

| File                  | Purpose             |
| --------------------- | ------------------- |
| `addon/manifest.json` | Plugin manifest     |
| `addon/content/`      | UI assets           |
| `src/modules/hermes/` | Core Hermes modules |
| `src/hooks.ts`        | Lifecycle hooks     |
| `.scaffold/build/`    | Build output        |

## Release Checklist

- [ ] Version bumped in package.json (`npm version patch --no-git-tag-version`)
- [ ] CHANGELOG.md `[Unreleased]` promoted to `[<ver>] — YYYY-MM-DD`
- [ ] **`npx prettier --check .`** — the repo's `lint:check` is whole-repo, not
      `src test`. CHANGELOG.md and other markdown are included; unformatted
      markdown (e.g. `*emphasis*` instead of `_emphasis_`) turns CI red.
- [ ] `npx tsc --noEmit` and `./node_modules/.bin/eslint src test` clean
- [ ] `npm test` — failures are compared as a SET against the known baseline,
      not by count. CI's `test` job has been red on main since 2026-09-10
      (`profileDir.clone is not a function`, goroutine deadlock on teardown);
      local `zotero-plugin test` shows the same 13 pre-existing failures with
      exit 1. Do not treat CI red as caused by the release unless the set grew.
- [ ] Commit `release: v<x.y.z>`, tag `v<x.y.z>`, push both — the tag push
      triggers the release workflow; do not `gh release create` by hand
- [ ] Verify the published release ships the XPI:
      `gh release view <tag> --json assets --jq '.assets[].name'`
- [ ] Submodule `.refs/zotero-pdfjs-types` restored if it accumulated noise
- [ ] README updated

## Testing Strategy

### Unit Tests

- Test individual modules in isolation
- Mock Zotero API calls
- Use vitest for test runner

### Integration Tests

- Test full chat flow
- Test note operations
- Test item context attachment

### Manual Testing

- Test in Zotero 9.0.0+ (current: 10.x, Mozilla 140 ESR)
- Test on Windows/macOS/Linux
- Test with large libraries (10,000+ items)

## Troubleshooting

### Common Issues

**Build fails with TypeScript errors**

- Check zotero-types version compatibility
- Verify tsconfig.json settings
- Run `npm run lint:fix`

**Plugin not loading in Zotero**

- Check manifest.json version compatibility
- Verify addon ID is unique
- Check browser console for errors

**Plugin not showing after an addon ID change**

`extensions.json` in the profile is authoritative — dropping an XPI into
`extensions/` is NOT enough; Zotero will not auto-discover it. To swap an
addon ID:

1. Quit Zotero.
2. Remove the stale entry from `extensions.json` (back it up first).
3. Write a new entry mirroring the known-good structure: `id`, `path`,
   `rootURI` (`jar:file://` with `%40` for `@`, `%20` for spaces, slashes
   preserved), `targetApplications` (zotero@zotero.org, min/max), `active:
true`, `userDisabled: false`, `installTelemetryInfo: {source:
"app-profile", method: "sideload"}`.
4. Restart Zotero and verify the plugin bootstrapped — its prefs
   (`extensions.zotero.<ref>.*`) only appear if startup code ran.

**Submodule noise before release**

`.refs/zotero-pdfjs-types` accumulates ~100 files of generated `.d.ts`
noise on every build. Restore it before committing a release so the
release doesn't record a dirty pointer:
`git -C .refs/zotero-pdfjs-types checkout -- .`

**ACP connection fails**

- Verify Hermes binary path
- Check permissions on binary
- Test with `hermes acp` manually

## Performance Optimization

### Bundle Size

- Use tree shaking
- Lazy load heavy components
- Minimize dependencies

### Runtime Performance

- Virtualize long lists
- Debounce input handlers
- Use requestAnimationFrame for animations

## Security Practices

- Never commit API keys
- Use Zotero's secure preference storage
- Validate all user inputs
- Sanitize AI-generated content before rendering
