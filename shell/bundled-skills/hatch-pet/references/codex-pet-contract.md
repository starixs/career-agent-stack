# keystone/Codex Pet Contract

## Sprite Atlas

- Format: PNG or WebP.
- Dimensions: `1536x1872`.
- Grid: 8 columns x 9 rows.
- Cell: `192x208`.
- Background: transparent.
- Unused cells: fully transparent.

The webview animation uses CSS background positions from the fixed row and column counts. Do not add labels, gutters, borders, grid lines, shadows outside the cell, or extra frames.

## Local Custom Pet Package

Place files under:

```text
${KEYSTONE_HOME:-$HOME/.keystone}/pets/<pet-name>/
├── pet.json
└── spritesheet.webp
```

Manifest shape:

```json
{
  "id": "pet-name",
  "displayName": "Pet Name",
  "description": "One short sentence.",
  "spritesheetPath": "spritesheet.webp"
}
```

keystone loads custom pets from the folder name under `${KEYSTONE_HOME:-$HOME/.keystone}/pets/`. Codex-compatible consumers can use the same package shape under `${CODEX_HOME:-$HOME/.codex}/pets/`.
