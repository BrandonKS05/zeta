# Overleaf extension (MVP)

This extension runs only on Overleaf pages and highlights:

- `apple` in red
- `banana` in yellow

The highlighting is applied in the source editor (`.cm-editor`) and not on rendered PDF text.

## Load in Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select: `/Users/aryan/Desktop/treehacks-2026/apps/overleaf-extension`

## Test

1. Open an Overleaf project
2. In the left source editor, type text containing `apple` and `banana`
3. Confirm red/yellow highlights appear while typing

## Notes

- This is an overlay-based highlighter for fast iteration.
- Next step is swapping token logic for actual grammar/model suggestions.
