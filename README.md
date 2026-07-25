# Logseq-Style Backlinks (Obsidian plugin)

Makes backlinks look and act like Logseq's **Linked References**: rendered as
real page content at the bottom of every note — not as a search-result list in
a sidebar.

Pairs with the [Logseqish theme](https://github.com/AlexKautz/obsidian-logseqish-theme),
which styles these reference sections to match Logseq exactly — but this plugin
works with any theme.

Also recommended: the
[Obsidian Outliner](https://github.com/vslinko/obsidian-outliner) plugin, which
completes the Logseq feel with structured list editing (Tab/Shift+Tab
indent and outdent, smart Enter, drag-and-drop). Verified compatible — its
list behaviors even work *inside* this plugin's inline block editors.

## Features

- **Linked References** section at the bottom of every note, in both reading
  view and live preview / source mode.
- Reference blocks are **fully rendered markdown** — wikilinks, formatting,
  and **math** (`$f(x) = ax^2 + bx + c$` renders via MathJax) — implemented
  directly with Obsidian's `MarkdownRenderer`, no other plugin required.
- Rendered at **body text size** (`var(--font-text-size)`), matching the note
  content, like Logseq.
- One card per referencing page, on the theme's secondary background, with the
  page name as an accent-colored link — Logseq's card look.
- Journal-style file names (`2026-07-24`) are shown as **Jul 24th, 2026**,
  like Logseq journal titles.
- Blocks act like Logseq blocks:
  - the block containing the link is extracted as the innermost list item
    **with all of its sub-bullets**, exactly like a Logseq block;
  - **click a block to edit it in place**, right in the references panel,
    in a real **Live Preview editor** — the same partial rendering you get
    in a normal pane (links and math render, raw syntax appears on the
    cursor line). Clicking away saves back to the source note, as does a
    configurable save shortcut (`Cmd+Enter` by default; `Cmd+S` and
    `Shift+Enter` available in Settings → Logseq-Style Backlinks), `Esc`
    cancels, and if the source changed in the meantime the save is
    refused instead of clobbering it. (The editor widget is resolved from
    Obsidian's internal embed registry — the Canvas-card pattern; if that
    private API ever changes, editing falls back to a plain text area.);
  - `Shift`-click a block to jump to it in its source note (with a flash
    highlight). The gesture is configurable in Settings → Logseq-Style
    Backlinks: Shift, Cmd/Ctrl, Alt/Option, Cmd/Ctrl+Shift, or never;
  - wikilinks inside blocks are clickable and show hover previews.
- Content that isn't a bullet — Obsidian allows that, Logseq doesn't — is
  shown honestly: a paragraph appears as a paragraph (no fake bullet), and
  headings are scaled to body size so a card never shouts.
- A list starting on the line directly below a paragraph (no blank line
  between) is treated as the paragraph's children, Logseq style: the line
  is the parent, and the whole thing is one block in the references panel.
- Collapsible **Unlinked References** section (collapsed by default, like
  Logseq) that finds plain-text mentions of the note name and highlights them.
  Exclusion is per block, like Logseq: a note that links in one block and
  plainly mentions the name in another appears in both sections, and content
  already shown as a linked reference is never duplicated.
- Journals sort first (newest first), then other pages alphabetically.
- Live updates: edit a note in one pane and the references under the target
  note update.

## Install with BRAT (recommended)

This plugin is not in the community plugin store, so the easiest way to install
it — and to keep getting updates — is
[BRAT](https://github.com/TfTHacker/obsidian42-brat).

1. Install **BRAT** from Settings → Community plugins → Browse, and enable it.
2. Open the command palette and run **BRAT: Add a beta plugin for testing**.
3. Paste this repository:

   ```
   AlexKautz/obsidian-logseq-backlinks
   ```

4. Leave the version as **Latest release** and click **Add plugin**.
5. Enable **Logseq-Style Backlinks** in Settings → Community plugins.

BRAT will then pull new releases automatically (or on demand via **BRAT: Check
for updates to all beta plugins**).

Tip: turn **off** the core "Backlinks in document" option so the two don't
stack.

## Manual install

Grab `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/AlexKautz/obsidian-logseq-backlinks/releases/latest)
and drop them in `YourVault/.obsidian/plugins/logseq-backlinks/`:

```bash
mkdir -p "/path/to/YourVault/.obsidian/plugins/logseq-backlinks"
gh release download --repo AlexKautz/obsidian-logseq-backlinks \
  --pattern main.js --pattern manifest.json --pattern styles.css \
  --dir "/path/to/YourVault/.obsidian/plugins/logseq-backlinks"
```

(Or copy the same three files from a checkout of this repo.) Then reload
Obsidian and enable **Logseq-Style Backlinks** in Settings → Community plugins.

## Build from source

With Node:

```bash
npm install
npm run build
```

With Deno (no Node needed):

```bash
deno run --node-modules-dir=none -A npm:esbuild@0.25.0 src/main.ts --bundle --external:obsidian --external:electron --format=cjs --target=es2020 --outfile=main.js
```

## How it works

- The section is appended to the note's scroll container: the
  `.markdown-preview-sizer` in reading view, the `.cm-sizer` in live preview —
  the same places Obsidian's own "backlinks in document" feature uses, so the
  references scroll with the note.
- Backlinks are found through `metadataCache.resolvedLinks`, and each link is
  mapped to its enclosing block (innermost list item, else section) using the
  file's metadata cache. The block's lines are extracted, dedented, and
  rendered with `MarkdownRenderer.render`, which is what makes math, links,
  and formatting work exactly as in the body of a note.
- Obsidian normally lets the editor flex-grow to fill the pane and adds a big
  bottom padding for scroll-past-end; two scoped `:has()` CSS rules disable
  that when references are present so they sit directly under the last line,
  the way Logseq shows them.
- Obsidian sometimes re-renders the reading view and drops injected DOM; a 1s
  repair interval re-inserts the section if it goes missing, and renders are
  serialized per view so they never race.
- Inline edits go through `vault.process` with an optimistic-concurrency
  check: the block's original lines must still match before they are
  replaced (re-indented to their original depth).

## Performance notes

- Re-renders are **skipped entirely when nothing changed**: each render
  fingerprints the collected references (paths, positions, raw text), and
  events that produce an identical result — a keystroke in an unrelated
  pane, a layout change — never touch the DOM, re-run `MarkdownRenderer`,
  or re-trigger the unlinked scan.
- Unlinked references are the only whole-vault scan, so they are computed
  **lazily** — only when the section is expanded, never on ordinary renders —
  and the scan yields to the UI every 250 files, so very large vaults stay
  responsive. Results cap at 50 pages, 20 blocks per page. Results are
  **cached until the vault changes** (reading view routinely drops and
  re-inserts the section while scrolling; re-inserts reuse the cache instead
  of rescanning), and a scan whose section is torn down mid-flight cancels
  itself instead of running to completion.
- Linked references touch only the files that actually link to the note
  (via `metadataCache.resolvedLinks`), read through Obsidian's in-memory
  `cachedRead`.
- Renders are debounced (150 ms), one-at-a-time per view, and skipped
  entirely for hidden tabs and while a block is being edited; the repair
  interval only does a cheap DOM existence check per visible pane.

## License

MIT — see [LICENSE](LICENSE).
