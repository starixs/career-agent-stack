# Symbols assets

The SVG files in this directory are vendored from
miguelsolorio/symbols, version
`0.0.25`, commit `296ef1b62287fb2315cb5651e552e09e8c8e1de8`.

- License: MIT; the unmodified upstream license is retained in `LICENSE`.
- Source paths: `src/icons/files/*.svg` and `src/icons/folders/*.svg`.
- Runtime: local static assets bundled by Vite. keystone never downloads them
  at runtime and does not depend on VS Code.
- Scope: only assets referenced by keystone' typed file-icon registry are
  vendored.
- Audit: `CHECKSUMS.sha256` records the bytes reviewed against the pinned
  upstream checkout. Contract tests fail if an SVG is added, removed, or
  changed without an explicit provenance update.

`files/presentation.svg` is a minimal derivative of upstream `files/image.svg`:
the geometry is unchanged and the purple resource color is replaced with the
Symbols amber used by presentation-oriented resources. It fills the only
common Office-family gap in the upstream set while preserving one visual
language. The derivative remains under the same MIT terms.

`files/markdown-inline.svg` is a keystone derivative of upstream
`files/markdown.svg`: the original mark and blue are retained, the mark is
scaled uniformly to 80%, and a rounded outline is added. The frame compensates
for the wide mark's low visual height beside prose. Only the inline size uses
this derivative; fixed-size icons retain the original. The derivative remains
under the same MIT terms and is included in the checksum snapshot.

`files/license.svg` is currently a byte-identical placeholder copy of upstream
`files/lock.svg`: the original vendored `license.svg` was lost when the
repository was archived, and the lock glyph was substituted so the `license`
and `security` registry entries keep a concrete asset. The checksum snapshot
records the placeholder bytes; restore the upstream `src/icons/files/license.svg`
and refresh the snapshot when the asset is re-vendored.
