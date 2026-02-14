# zeta (Overleaf extension)

**Grammarly for Math**

This extension runs on Overleaf source editors and applies live underlines while you type:

- `apple` in red underline
- `banana` in yellow underline

Clicking an underline opens a Grammarly-style suggestion popup with replacement options.

Editor detection targets both Overleaf editor DOM variants (`.cm-editor` and `.ace_editor`) to keep live underlines working across projects.

## Mode toggle

Use the extension popup to choose a Cursor-like mode toggle:

- `fast`: immediate updates
- `accurate`: slight delay for cleaner suggestion updates
- `auto`: stays fast unless the editor content becomes very large

## Branding

- Extension name: `zeta`
- Tagline: `Grammarly for Math`
- Logo asset: `assets/zeta-black-white-2048.png` (high-res black-on-white zeta)

## Load in Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select: `/Users/aryan/Desktop/treehacks-2026/apps/overleaf-extension`

## Test

1. Open an Overleaf project
2. Type `apple` and `banana` in the source editor
3. Confirm underlines appear while typing
4. Click the underlined text and verify the suggestion popup appears
5. Switch mode in the extension popup and verify behavior updates
