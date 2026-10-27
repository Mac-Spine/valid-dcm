# VALID-DCM / MAC Spine

Mobile research assessment PWA with Grip & Release and Timed Up & Go modules. The frontend is hosted on GitHub Pages; a separate Cloudflare Worker relays assessments to REDCap.

## Development

Use Node.js 24 to match the Pages workflow.

```sh
cd mac_spine
npm ci
npm run dev
```

For HTTPS testing on a phone, see `mac_spine/scripts/setup-https.sh`. Local certificates are excluded from Git.

## Checks and build

From `mac_spine`:

```sh
npm run typecheck
npm test
npm run lint
npm run build
```

At migration, the app build and typecheck passed. The test suite has known stale tapping/name-validation tests, and lint reports an unused `gripCycleCount`. Pocket flow tests pass; physical-device accuracy and REDCap integration still require validation.

## Hosting

- Repository: https://github.com/Mac-Spine/valid-dcm
- Pages: https://mac-spine.github.io/valid-dcm/
- Deployment: root `.github/workflows/deploy.yml`, on pushes to `main`.
- Pages publishing source: GitHub Actions.

The production asset base is derived from the repository name. The workflow publishes only `mac_spine/dist`; researcher tools and backend source are not part of the hosted frontend.

## REDCap and backend

See [proxy documentation](docs/api_proxy.md), [Worker setup](mac_spine/api_proxy/README.md), and [data dictionaries](docs/data_dictionary/README.md). Researcher utilities are in `tools/`.

Keep `REDCAP_API_URL`, `REDCAP_API_TOKEN`, and `ALLOWED_ORIGIN` in Cloudflare secrets. For this Pages site, the allowed browser origin is `https://mac-spine.github.io` (no repository path or trailing slash). Coordinate the origin cutover with existing users; the current Worker allows one origin. GitHub Pages does not deploy the Worker.

Data stored in browser IndexedDB on an older hosting origin does not automatically migrate to this site. Sync/export existing assessments before switching. Verify participant linkage and synthetic Grip/TUG uploads before participant use.

## Repository scope

This repository keeps application source, required media, tests, build configuration, Worker source, data dictionaries, and maintenance documentation. Conversation summaries, assistant memories, duplicate design originals, and historical planning notes stay local and are ignored. Existing upstream Git history and license are retained.
