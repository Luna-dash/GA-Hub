# Versioning and releases

`pyproject.toml` → `project.version` is the authoritative product version.

## Bump and verify

1. Edit only that version (SemVer: patch = fixes, minor = compatible features, major = breaking changes).
2. Run `python scripts/sync_version.py` to update the first-party npm/Tauri/Cargo/API manifests, lock root packages and OpenAPI metadata. It does not upgrade dependencies.
3. Run `python scripts/sync_version.py --check` and `python -m pytest tests/test_version_consistency.py tests/test_release_packaging.py -q`.
4. Write `docs/releases/vX.Y.Z.md`, commit all changes, and push main.
5. Tag that exact commit (`git tag -a vX.Y.Z -m "GA-Hub X.Y.Z"`), then push the tag. Never move/reuse a published version tag.

## Build and publish

The `desktop-build` workflow uses the sole `scripts/build_all.py` entrypoint (frontend → sidecar → Tauri --no-bundle → artifact guards → frozen runtime selftest).

- Main/manual builds publish Actions artifacts only, with preview filenames containing the commit hash.
- A `v*` tag must equal `v` + product version. A successful tag build packages both EXEs and publishes a stable GitHub Release, with the checked-in release notes.
- `scripts/package_release.py` records full commit, UTC packaging time, platform, channel, tracked-tree dirty state and binary SHA-256 in `build-info.json`; it rejects dirty stable builds, missing/empty EXEs and mismatched tags.
- `SHA256SUMS.txt` includes the ZIP and both EXEs. Both EXEs retain their existing filenames and must stay together.
- Build provenance is in the downloadable metadata; no in-app About UI or automatic updater is implemented by this change.

Local deliverable builds still use `build_all.bat` / `python scripts/build_all.py`; never overwrite an in-use production EXE. Release workflow output is built in a clean cloud checkout, not by stopping a local running instance.
