"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => LogseqBacklinksPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

// src/editor.ts
var editorClass = null;
function resolveEditorClass(app) {
  if (editorClass) return editorClass;
  const embed = app.embedRegistry.embedByExtension.md(
    { app, containerEl: createDiv() },
    null,
    ""
  );
  embed.load();
  embed.editable = true;
  embed.showEditor();
  editorClass = Object.getPrototypeOf(
    Object.getPrototypeOf(embed.editMode)
  ).constructor;
  embed.unload();
  return editorClass;
}
function createEmbeddedEditor(app, container, initialValue) {
  try {
    const EditorClass = resolveEditorClass(app);
    const owner = {
      app,
      onMarkdownScroll: () => {
      },
      getMode: () => "source"
    };
    const editor = new EditorClass(app, container, owner);
    owner.editMode = editor;
    Object.defineProperty(owner, "editor", {
      get: () => editor.editor,
      configurable: true
    });
    editor.set(initialValue, true);
    const cm = () => editor.cm ?? editor.editor?.cm;
    let destroyed = false;
    return {
      get value() {
        return cm()?.state?.doc?.toString() ?? editor.editor?.getValue() ?? initialValue;
      },
      focus() {
        const view = cm();
        if (view) {
          view.focus();
          view.dispatch({ selection: { anchor: view.state.doc.length } });
        } else {
          editor.editor?.focus?.();
        }
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        editor.destroy?.();
        editor.unload?.();
      }
    };
  } catch (error) {
    console.error(
      "logseq-backlinks: embedded live-preview editor unavailable, falling back to plain editor",
      error
    );
    return null;
  }
}

// src/main.ts
var DEFAULT_SETTINGS = {
  jumpGesture: "shift",
  saveShortcut: "mod-enter"
};
var SAVE_SHORTCUT_LABELS = {
  "mod-enter": "Cmd/Ctrl + Enter",
  "mod-s": "Cmd/Ctrl + S",
  "shift-enter": "Shift + Enter",
  none: "None (click away to save)"
};
var SAVE_SHORTCUT_KEYS = {
  "mod-enter": { modifiers: ["Mod"], key: "Enter" },
  "mod-s": { modifiers: ["Mod"], key: "S" },
  "shift-enter": { modifiers: ["Shift"], key: "Enter" },
  none: null
};
var JUMP_GESTURE_LABELS = {
  shift: "Shift + click",
  mod: "Cmd/Ctrl + click",
  alt: "Alt/Option + click",
  "mod-shift": "Cmd/Ctrl + Shift + click",
  none: "Never (blocks only edit)"
};
function matchesJumpGesture(evt, gesture) {
  const mod = evt.metaKey || evt.ctrlKey;
  switch (gesture) {
    case "shift":
      return evt.shiftKey && !mod && !evt.altKey;
    case "mod":
      return mod && !evt.shiftKey && !evt.altKey;
    case "alt":
      return evt.altKey && !mod && !evt.shiftKey;
    case "mod-shift":
      return mod && evt.shiftKey && !evt.altKey;
    case "none":
      return false;
  }
}
var DAILY_NOTE_RE = /^(\d{4})[-_](\d{2})[-_](\d{2})$/;
var ORDINALS = { 1: "st", 2: "nd", 3: "rd", 21: "st", 22: "nd", 23: "rd", 31: "st" };
var MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];
function displayName(file) {
  const m = DAILY_NOTE_RE.exec(file.basename);
  if (!m) return file.basename;
  const [, y, mo, d] = m;
  const day = parseInt(d, 10);
  const month = MONTHS[parseInt(mo, 10) - 1];
  if (!month || !day) return file.basename;
  return `${month} ${day}${ORDINALS[day] ?? "th"}, ${y}`;
}
function journalDate(file) {
  const m = DAILY_NOTE_RE.exec(file.basename);
  if (!m) return null;
  return parseInt(m[1] + m[2] + m[3], 10);
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var LogseqBacklinksPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.viewStates = /* @__PURE__ */ new WeakMap();
    this.rendering = /* @__PURE__ */ new WeakSet();
    this.renderAgain = /* @__PURE__ */ new WeakSet();
    this.refresh = (0, import_obsidian.debounce)(() => this.updateAllViews(), 150, true);
    /** Bumped on any vault change; invalidates cached unlinked results. */
    this.vaultRev = 0;
    this.unlinkedCache = /* @__PURE__ */ new Map();
    this.settings = { ...DEFAULT_SETTINGS };
  }
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...await this.loadData() };
    this.addSettingTab(new LogseqBacklinksSettingTab(this));
    const bumpRev = () => {
      this.vaultRev++;
      this.unlinkedCache.clear();
    };
    this.registerEvent(this.app.vault.on("modify", bumpRev));
    this.registerEvent(this.app.vault.on("create", bumpRev));
    this.registerEvent(this.app.vault.on("delete", bumpRev));
    this.registerEvent(this.app.vault.on("rename", bumpRev));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refresh()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refresh()));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.refresh()));
    this.app.workspace.onLayoutReady(() => this.refresh());
    this.registerInterval(
      window.setInterval(() => {
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
          const view = leaf.view;
          if (!view.file || !view.containerEl.isShown()) continue;
          if (this.viewStates.get(view)?.editing) continue;
          if (!view.containerEl.querySelector(".logseq-backlinks")) {
            void this.renderForView(view);
          }
        }
      }, 1e3)
    );
  }
  onunload() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      view.containerEl.querySelectorAll(".logseq-backlinks").forEach((el) => el.remove());
      this.viewStates.get(view)?.component.unload();
    }
  }
  updateAllViews() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!view.containerEl.isShown()) continue;
      void this.renderForView(view);
    }
  }
  state(view) {
    let state = this.viewStates.get(view);
    if (!state) {
      state = {
        component: new import_obsidian.Component(),
        unlinkedCollapsed: true,
        linkedCollapsed: false,
        editing: false,
        lastFingerprint: null
      };
      this.viewStates.set(view, state);
    }
    return state;
  }
  async renderForView(view) {
    if (this.rendering.has(view)) {
      this.renderAgain.add(view);
      return;
    }
    this.rendering.add(view);
    try {
      await this.doRender(view);
    } finally {
      this.rendering.delete(view);
      if (this.renderAgain.delete(view)) void this.renderForView(view);
    }
  }
  async doRender(view) {
    const file = view.file;
    if (!file) return;
    const state = this.state(view);
    if (state.editing) return;
    const linked = await this.collectLinkedReferences(file);
    if (view.file?.path !== file.path || state.editing) return;
    const sizer = view.getMode() === "preview" ? view.containerEl.querySelector(".markdown-preview-sizer") : view.containerEl.querySelector(".cm-sizer");
    if (!sizer || !sizer.isConnected) return;
    const fingerprint = view.getMode() + "\0" + linked.map(
      (g) => g.file.path + "" + g.blocks.map((b) => `${b.startLine}:${b.rawText}`).join("")
    ).join("");
    if (state.lastFingerprint === fingerprint && sizer.querySelector(":scope > .logseq-backlinks")) {
      return;
    }
    state.lastFingerprint = fingerprint;
    state.component.unload();
    state.component = new import_obsidian.Component();
    state.component.load();
    view.containerEl.querySelectorAll(".logseq-backlinks").forEach((el) => el.remove());
    const root = createDiv({ cls: "logseq-backlinks" });
    sizer.appendChild(root);
    const total = linked.reduce((n, g) => n + g.blocks.length, 0);
    this.renderSection(root, view, state, {
      title: `${total} Linked ${total === 1 ? "Reference" : "References"}`,
      groups: linked,
      collapsed: state.linkedCollapsed,
      setCollapsed: (c) => state.linkedCollapsed = c,
      highlight: null
    });
    const linkedRanges = /* @__PURE__ */ new Map();
    for (const g of linked) {
      linkedRanges.set(g.file.path, g.blocks.map((b) => [b.startLine, b.endLine]));
    }
    this.renderSection(root, view, state, {
      title: "Unlinked References",
      // Results are cached until the vault changes: the repair interval
      // re-inserts our section whenever Obsidian's reading view drops it
      // (which happens routinely while scrolling), and re-running a
      // whole-vault scan on each re-insert would pile up on large vaults.
      lazyLoad: async (isCancelled) => {
        const cached = this.unlinkedCache.get(file.path);
        if (cached && cached.rev === this.vaultRev) return cached.groups;
        const rev = this.vaultRev;
        const groups = await this.collectUnlinkedReferences(
          file,
          linkedRanges,
          isCancelled
        );
        if (groups) this.unlinkedCache.set(file.path, { rev, groups });
        return groups;
      },
      collapsed: state.unlinkedCollapsed,
      setCollapsed: (c) => state.unlinkedCollapsed = c,
      highlight: file.basename
    });
  }
  renderSection(root, view, state, opts) {
    const section = root.createDiv({ cls: "logseq-backlinks-section" });
    const heading = section.createDiv({
      cls: "logseq-backlinks-heading",
      attr: { role: "button", tabindex: "0" }
    });
    const caret = heading.createSpan({ cls: "logseq-backlinks-caret" });
    (0, import_obsidian.setIcon)(caret, "chevron-down");
    heading.createSpan({ cls: "logseq-backlinks-title", text: opts.title });
    const body = section.createDiv({ cls: "logseq-backlinks-body" });
    if (opts.groups) this.renderGroups(body, opts.groups, view, state, opts.highlight);
    let loaded = !opts.lazyLoad;
    const ensureLoaded = async () => {
      if (loaded) return;
      loaded = true;
      const groups = await opts.lazyLoad(() => !body.isConnected);
      if (!groups || !body.isConnected) return;
      if (groups.length === 0) {
        body.createDiv({
          cls: "logseq-backlinks-empty",
          text: "No unlinked references"
        });
      } else {
        this.renderGroups(body, groups, view, state, opts.highlight);
      }
    };
    const applyCollapsed = (c) => {
      section.toggleClass("is-collapsed", c);
      body.toggleClass("is-hidden", c);
      heading.setAttribute("aria-expanded", String(!c));
    };
    applyCollapsed(opts.collapsed);
    if (!opts.collapsed) void ensureLoaded();
    const toggle = () => {
      const collapsed = !section.hasClass("is-collapsed");
      opts.setCollapsed(collapsed);
      applyCollapsed(collapsed);
      if (!collapsed) void ensureLoaded();
    };
    heading.addEventListener("click", toggle);
    heading.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        toggle();
      }
    });
  }
  renderGroups(body, groups, view, state, highlight) {
    for (const group of groups) {
      const card = body.createDiv({ cls: "logseq-backlinks-card" });
      const pageLink = card.createDiv({
        cls: "logseq-backlinks-page",
        text: displayName(group.file),
        attr: { role: "link", tabindex: "0" }
      });
      const openPage = (evt) => {
        void this.app.workspace.getLeaf(import_obsidian.Keymap.isModEvent(evt)).openFile(group.file);
      };
      pageLink.addEventListener("click", openPage);
      pageLink.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") openPage(evt);
      });
      for (const block of group.blocks) {
        const blockEl = card.createDiv({
          cls: "logseq-backlinks-block markdown-rendered"
        });
        void import_obsidian.MarkdownRenderer.render(
          this.app,
          block.markdown,
          blockEl,
          group.file.path,
          state.component
        ).then(() => {
          if (highlight) this.highlightText(blockEl, highlight);
        });
        blockEl.addEventListener("click", (evt) => {
          const target = evt.target;
          if (target.closest("a")) return;
          if (window.getSelection()?.toString()) return;
          if (matchesJumpGesture(evt, this.settings.jumpGesture)) {
            void this.app.workspace.getLeaf(false).openFile(group.file, {
              eState: { line: block.startLine }
            });
            return;
          }
          this.beginEdit(view, state, blockEl, group.file, block);
        });
      }
      this.wireLinks(card, view, group.file.path);
    }
  }
  // ------------------------------------------------------------------
  // Inline editing, Logseq style: click a block, edit its markdown in
  // place, blur (or Cmd+Enter) saves back to the source note.
  // ------------------------------------------------------------------
  beginEdit(view, state, blockEl, file, block) {
    if (state.editing || !blockEl.isConnected) return;
    state.editing = true;
    state.lastFingerprint = null;
    blockEl.addClass("is-editing");
    blockEl.empty();
    const scope = new import_obsidian.Scope(this.app.scope);
    this.app.keymap.pushScope(scope);
    let popped = false;
    const popScope = () => {
      if (popped) return;
      popped = true;
      this.app.keymap.popScope(scope);
    };
    state.component.register(popScope);
    let done = false;
    const makeFinish = (getValue, cleanup) => async (save) => {
      if (done) return;
      done = true;
      const value = getValue();
      popScope();
      cleanup();
      state.editing = false;
      if (save && value !== block.markdown) {
        await this.saveBlock(file, block, value);
      }
      void this.renderForView(view);
    };
    const bindKeys = (finish2) => {
      scope.register([], "Escape", () => {
        void finish2(false);
        return false;
      });
      const shortcut = SAVE_SHORTCUT_KEYS[this.settings.saveShortcut];
      if (shortcut) {
        scope.register(shortcut.modifiers, shortcut.key, () => {
          void finish2(true);
          return false;
        });
      }
    };
    const embedded = createEmbeddedEditor(this.app, blockEl, block.markdown);
    if (embedded) {
      state.component.register(() => embedded.destroy());
      const finish2 = makeFinish(
        () => embedded.value,
        () => embedded.destroy()
      );
      bindKeys(finish2);
      blockEl.addEventListener("focusout", (evt) => {
        const to = evt.relatedTarget;
        if (!(to instanceof Node) || !blockEl.contains(to)) {
          void finish2(true);
        }
      });
      window.requestAnimationFrame(() => embedded.focus());
      return;
    }
    const ta = blockEl.createEl("textarea", {
      cls: "logseq-backlinks-editor"
    });
    ta.value = block.markdown;
    const grow = () => {
      ta.style.height = "0";
      ta.style.height = `${ta.scrollHeight}px`;
    };
    ta.addEventListener("input", grow);
    window.requestAnimationFrame(() => {
      grow();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    const finish = makeFinish(() => ta.value, () => {
    });
    bindKeys(finish);
    ta.addEventListener("blur", () => void finish(true));
  }
  async saveBlock(file, block, newMarkdown) {
    await this.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      const current = lines.slice(block.startLine, block.endLine + 1).join("\n");
      if (current !== block.rawText) {
        new import_obsidian.Notice(
          "This block changed in the meantime; nothing was saved."
        );
        return data;
      }
      const replacement = newMarkdown.split("\n").map((l) => l.length > 0 ? block.indent + l : l);
      lines.splice(
        block.startLine,
        block.endLine - block.startLine + 1,
        ...replacement
      );
      return lines.join("\n");
    });
  }
  /** Make internal links rendered by MarkdownRenderer clickable + hoverable. */
  wireLinks(el, view, sourcePath) {
    el.addEventListener("click", (evt) => {
      const link = evt.target.closest("a.internal-link");
      if (!link) return;
      evt.preventDefault();
      evt.stopPropagation();
      const href = link.getAttribute("data-href") ?? link.getAttribute("href");
      if (href) {
        void this.app.workspace.openLinkText(
          href,
          sourcePath,
          import_obsidian.Keymap.isModEvent(evt)
        );
      }
    });
    el.addEventListener("mouseover", (evt) => {
      const link = evt.target.closest("a.internal-link");
      if (!link) return;
      this.app.workspace.trigger("hover-link", {
        event: evt,
        source: "preview",
        hoverParent: view,
        targetEl: link,
        linktext: link.getAttribute("data-href") ?? link.getAttribute("href"),
        sourcePath
      });
    });
  }
  highlightText(el, needle) {
    const re = new RegExp(escapeRegex(needle), "gi");
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;
    while (node = walker.nextNode()) textNodes.push(node);
    for (const text of textNodes) {
      const value = text.nodeValue ?? "";
      if (!re.test(value)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const match of value.matchAll(re)) {
        const index = match.index ?? 0;
        frag.appendChild(document.createTextNode(value.slice(last, index)));
        const mark = document.createElement("mark");
        mark.textContent = match[0];
        frag.appendChild(mark);
        last = index + match[0].length;
      }
      frag.appendChild(document.createTextNode(value.slice(last)));
      text.replaceWith(frag);
    }
  }
  // ------------------------------------------------------------------
  // Reference collection
  // ------------------------------------------------------------------
  async collectLinkedReferences(target) {
    const resolved = this.app.metadataCache.resolvedLinks;
    const groups = [];
    for (const sourcePath of Object.keys(resolved)) {
      if (sourcePath === target.path) continue;
      if (!resolved[sourcePath]?.[target.path]) continue;
      const source = this.app.vault.getAbstractFileByPath(sourcePath);
      if (!(source instanceof import_obsidian.TFile)) continue;
      const cache = this.app.metadataCache.getFileCache(source);
      if (!cache) continue;
      const refs = [...cache.links ?? [], ...cache.embeds ?? []].filter(
        (ref) => {
          const dest = this.app.metadataCache.getFirstLinkpathDest(
            (0, import_obsidian.getLinkpath)(ref.link),
            sourcePath
          );
          return dest?.path === target.path;
        }
      );
      if (refs.length === 0) continue;
      const lines = (await this.app.vault.cachedRead(source)).split("\n");
      const seen = /* @__PURE__ */ new Map();
      for (const ref of refs) {
        const range = this.blockRangeForLine(cache, ref.position.start.line);
        const key = `${range.start}-${range.end}`;
        if (seen.has(key)) continue;
        seen.set(key, this.extractBlock(lines, range.start, range.end));
      }
      const blocks = [...seen.values()].sort(
        (a, b) => a.startLine - b.startLine
      );
      groups.push({ file: source, blocks });
    }
    return this.sortGroups(groups);
  }
  async collectUnlinkedReferences(target, linkedRanges, isCancelled) {
    const name = target.basename;
    if (name.length < 2) return [];
    const re = new RegExp(
      `(^|[^\\w\\[])(${escapeRegex(name)})([^\\w\\]]|$)`,
      "i"
    );
    const groups = [];
    const files = this.app.vault.getMarkdownFiles();
    let scanned = 0;
    for (const source of files) {
      if (source.path === target.path) continue;
      if (groups.length >= 50) break;
      if (++scanned % 250 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (isCancelled()) return null;
      }
      const content = await this.app.vault.cachedRead(source);
      if (!re.test(content)) continue;
      const cache = this.app.metadataCache.getFileCache(source);
      if (!cache) continue;
      const covered = linkedRanges.get(source.path) ?? [];
      const lines = content.split("\n");
      const seen = /* @__PURE__ */ new Map();
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        const range = this.blockRangeForLine(cache, i);
        if (covered.some(([s, e]) => s <= range.start && range.end <= e))
          continue;
        const key = `${range.start}-${range.end}`;
        if (seen.has(key)) continue;
        seen.set(key, this.extractBlock(lines, range.start, range.end));
        if (seen.size >= 20) break;
      }
      if (seen.size > 0) {
        groups.push({
          file: source,
          blocks: [...seen.values()].sort((a, b) => a.startLine - b.startLine)
        });
      }
    }
    return this.sortGroups(groups);
  }
  /**
   * The block containing a line: the innermost list item if the line is in a
   * list — extended to include all of its descendants, like a Logseq block
   * with its sub-bullets — otherwise the containing section.
   */
  blockRangeForLine(cache, line) {
    const items = cache.listItems ?? [];
    let best = null;
    for (const item of items) {
      const s = item.position.start.line;
      const e = item.position.end.line;
      if (s <= line && line <= e && (!best || s >= best.position.start.line)) {
        best = item;
      }
    }
    if (best) {
      const start = best.position.start.line;
      let end = best.position.end.line;
      const byStart = new Map(items.map((i) => [i.position.start.line, i]));
      for (const item of items) {
        let p = item.parent;
        while (p >= 0) {
          if (p === start) {
            end = Math.max(end, item.position.end.line);
            break;
          }
          p = byStart.get(p)?.parent ?? -1;
        }
      }
      return { start, end };
    }
    const sections = cache.sections ?? [];
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i].position.start.line;
      let e = sections[i].position.end.line;
      if (s <= line && line <= e) {
        const next = sections[i + 1];
        if (sections[i].type !== "list" && next?.type === "list" && next.position.start.line === e + 1) {
          e = next.position.end.line;
        }
        return { start: s, end: e };
      }
    }
    return { start: line, end: line };
  }
  /**
   * Extract a block as standalone markdown, dedented to the left margin.
   * List blocks keep their bullet and sub-bullets; anything else (a
   * paragraph, a heading...) is rendered as-is — unlike Logseq, Obsidian
   * notes are not always bullets, and we don't pretend otherwise.
   */
  extractBlock(lines, start, end) {
    const raw = lines.slice(start, end + 1);
    const indent = /^[\t ]*/.exec(raw[0])?.[0] ?? "";
    const dedented = raw.map(
      (l) => l.startsWith(indent) ? l.slice(indent.length) : l.trimStart()
    );
    return {
      startLine: start,
      endLine: end,
      markdown: dedented.join("\n"),
      rawText: raw.join("\n"),
      indent
    };
  }
  /** Journals first, newest first — like Logseq — then other pages A-Z. */
  sortGroups(groups) {
    return groups.sort((a, b) => {
      const da = journalDate(a.file);
      const db = journalDate(b.file);
      if (da !== null && db !== null) return db - da;
      if (da !== null) return -1;
      if (db !== null) return 1;
      return a.file.basename.localeCompare(b.file.basename);
    });
  }
};
var LogseqBacklinksSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(plugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }
  display() {
    this.containerEl.empty();
    new import_obsidian.Setting(this.containerEl).setName("Save shortcut").setDesc(
      "Keyboard shortcut that saves an inline block edit back to the source note. Clicking away always saves; Esc always cancels."
    ).addDropdown((dropdown) => {
      for (const [value, label] of Object.entries(SAVE_SHORTCUT_LABELS)) {
        dropdown.addOption(value, label);
      }
      dropdown.setValue(this.plugin.settings.saveShortcut).onChange(async (value) => {
        this.plugin.settings.saveShortcut = value;
        await this.plugin.saveData(this.plugin.settings);
      });
    });
    new import_obsidian.Setting(this.containerEl).setName("Jump to source").setDesc(
      "Click gesture that opens a reference block in its source note. A plain click always edits the block in place, like Logseq."
    ).addDropdown((dropdown) => {
      for (const [value, label] of Object.entries(JUMP_GESTURE_LABELS)) {
        dropdown.addOption(value, label);
      }
      dropdown.setValue(this.plugin.settings.jumpGesture).onChange(async (value) => {
        this.plugin.settings.jumpGesture = value;
        await this.plugin.saveData(this.plugin.settings);
      });
    });
  }
};
