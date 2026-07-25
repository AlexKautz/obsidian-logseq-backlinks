import {
	CachedMetadata,
	Component,
	Keymap,
	MarkdownRenderer,
	MarkdownView,
	Modifier,
	Notice,
	Plugin,
	PluginSettingTab,
	Scope,
	Setting,
	TFile,
	debounce,
	getLinkpath,
	setIcon,
} from "obsidian";
import { createEmbeddedEditor } from "./editor";

interface RefBlock {
	/** 0-based line range of the block (including its children) in the source file */
	startLine: number;
	endLine: number;
	/** Dedented markdown, what we render and edit */
	markdown: string;
	/** Exact original lines, used to detect concurrent edits before saving */
	rawText: string;
	/** Leading whitespace of the first line, re-applied on save */
	indent: string;
}

interface RefGroup {
	file: TFile;
	blocks: RefBlock[];
}

interface ViewState {
	component: Component;
	unlinkedCollapsed: boolean;
	linkedCollapsed: boolean;
	/** True while a block is being edited inline; suspends re-renders */
	editing: boolean;
}

type JumpGesture = "shift" | "mod" | "alt" | "mod-shift" | "none";
type SaveShortcut = "mod-enter" | "mod-s" | "shift-enter" | "none";

interface LogseqBacklinksSettings {
	/** Click gesture that jumps to a block's source note (plain click edits). */
	jumpGesture: JumpGesture;
	/** Keyboard shortcut that saves an inline edit (blur always saves). */
	saveShortcut: SaveShortcut;
}

const DEFAULT_SETTINGS: LogseqBacklinksSettings = {
	jumpGesture: "shift",
	saveShortcut: "mod-enter",
};

const SAVE_SHORTCUT_LABELS: Record<SaveShortcut, string> = {
	"mod-enter": "Cmd/Ctrl + Enter",
	"mod-s": "Cmd/Ctrl + S",
	"shift-enter": "Shift + Enter",
	none: "None (click away to save)",
};

const SAVE_SHORTCUT_KEYS: Record<
	SaveShortcut,
	{ modifiers: Modifier[]; key: string } | null
> = {
	"mod-enter": { modifiers: ["Mod"], key: "Enter" },
	"mod-s": { modifiers: ["Mod"], key: "S" },
	"shift-enter": { modifiers: ["Shift"], key: "Enter" },
	none: null,
};

const JUMP_GESTURE_LABELS: Record<JumpGesture, string> = {
	shift: "Shift + click",
	mod: "Cmd/Ctrl + click",
	alt: "Alt/Option + click",
	"mod-shift": "Cmd/Ctrl + Shift + click",
	none: "Never (blocks only edit)",
};

function matchesJumpGesture(evt: MouseEvent, gesture: JumpGesture): boolean {
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

const DAILY_NOTE_RE = /^(\d{4})[-_](\d{2})[-_](\d{2})$/;
const ORDINALS: Record<number, string> = { 1: "st", 2: "nd", 3: "rd", 21: "st", 22: "nd", 23: "rd", 31: "st" };
const MONTHS = [
	"Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-07-24" -> "Jul 24th, 2026", like a Logseq journal title. */
function displayName(file: TFile): string {
	const m = DAILY_NOTE_RE.exec(file.basename);
	if (!m) return file.basename;
	const [, y, mo, d] = m;
	const day = parseInt(d, 10);
	const month = MONTHS[parseInt(mo, 10) - 1];
	if (!month || !day) return file.basename;
	return `${month} ${day}${ORDINALS[day] ?? "th"}, ${y}`;
}

function journalDate(file: TFile): number | null {
	const m = DAILY_NOTE_RE.exec(file.basename);
	if (!m) return null;
	return parseInt(m[1] + m[2] + m[3], 10);
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default class LogseqBacklinksPlugin extends Plugin {
	private viewStates = new WeakMap<MarkdownView, ViewState>();
	private rendering = new WeakSet<MarkdownView>();
	private renderAgain = new WeakSet<MarkdownView>();
	private refresh = debounce(() => this.updateAllViews(), 150, true);

	settings: LogseqBacklinksSettings = { ...DEFAULT_SETTINGS };

	async onload() {
		this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
		this.addSettingTab(new LogseqBacklinksSettingTab(this));

		this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refresh()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refresh()));
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.refresh()));
		this.app.workspace.onLayoutReady(() => this.refresh());

		// Obsidian occasionally re-renders the reading view and drops our
		// container; put it back whenever it goes missing.
		this.registerInterval(
			window.setInterval(() => {
				for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
					const view = leaf.view as MarkdownView;
					if (!view.file || !view.containerEl.isShown()) continue;
					if (this.viewStates.get(view)?.editing) continue;
					if (!view.containerEl.querySelector(".logseq-backlinks")) {
						void this.renderForView(view);
					}
				}
			}, 1000)
		);
	}

	onunload() {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as MarkdownView;
			view.containerEl
				.querySelectorAll(".logseq-backlinks")
				.forEach((el) => el.remove());
			this.viewStates.get(view)?.component.unload();
		}
	}

	private updateAllViews() {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as MarkdownView;
			// Hidden tabs are rendered lazily: when one becomes visible,
			// active-leaf-change / the repair interval picks it up.
			if (!view.containerEl.isShown()) continue;
			void this.renderForView(view);
		}
	}

	private state(view: MarkdownView): ViewState {
		let state = this.viewStates.get(view);
		if (!state) {
			state = {
				component: new Component(),
				unlinkedCollapsed: true,
				linkedCollapsed: false,
				editing: false,
			};
			this.viewStates.set(view, state);
		}
		return state;
	}

	private async renderForView(view: MarkdownView) {
		// One render at a time per view; if another request comes in while we
		// are mid-render, run once more when done instead of racing.
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

	private async doRender(view: MarkdownView) {
		const file = view.file;
		if (!file) return;

		const state = this.state(view);
		if (state.editing) return;

		const linked = await this.collectLinkedReferences(file);

		// The view may have moved on while we were collecting; bail out and
		// let the next event (or the repair interval) render the new state.
		if (view.file?.path !== file.path || state.editing) return;

		// The scrollable content sizer for the current mode: reading view uses
		// the preview sizer, live preview / source mode use the CodeMirror sizer.
		// Queried after the await — a mode switch replaces this DOM.
		const sizer =
			view.getMode() === "preview"
				? view.containerEl.querySelector(".markdown-preview-sizer")
				: view.containerEl.querySelector(".cm-sizer");
		if (!sizer || !sizer.isConnected) return;

		state.component.unload();
		state.component = new Component();
		state.component.load();

		// Drop stale containers from both modes before appending a fresh one.
		view.containerEl
			.querySelectorAll(".logseq-backlinks")
			.forEach((el) => el.remove());

		// Always append the (possibly empty) container: it doubles as the
		// marker that tells the repair interval this view is up to date.
		const root = createDiv({ cls: "logseq-backlinks" });
		sizer.appendChild(root);

		const total = linked.reduce((n, g) => n + g.blocks.length, 0);
		this.renderSection(root, view, state, {
			title: `${total} Linked ${total === 1 ? "Reference" : "References"}`,
			groups: linked,
			collapsed: state.linkedCollapsed,
			setCollapsed: (c) => (state.linkedCollapsed = c),
			highlight: null,
		});

		// Unlinked references scan the whole vault, so they are only computed
		// when the section is actually expanded. Exclusion is per block, like
		// Logseq: a note that links in one block can still surface a plain
		// mention from another block.
		const linkedRanges = new Map<string, Array<[number, number]>>();
		for (const g of linked) {
			linkedRanges.set(g.file.path, g.blocks.map((b) => [b.startLine, b.endLine]));
		}
		this.renderSection(root, view, state, {
			title: "Unlinked References",
			lazyLoad: () => this.collectUnlinkedReferences(file, linkedRanges),
			collapsed: state.unlinkedCollapsed,
			setCollapsed: (c) => (state.unlinkedCollapsed = c),
			highlight: file.basename,
		});
	}

	private renderSection(
		root: HTMLElement,
		view: MarkdownView,
		state: ViewState,
		opts: {
			title: string;
			groups?: RefGroup[];
			lazyLoad?: () => Promise<RefGroup[]>;
			collapsed: boolean;
			setCollapsed: (c: boolean) => void;
			highlight: string | null;
		}
	) {
		const section = root.createDiv({ cls: "logseq-backlinks-section" });
		const heading = section.createDiv({
			cls: "logseq-backlinks-heading",
			attr: { role: "button", tabindex: "0" },
		});
		const caret = heading.createSpan({ cls: "logseq-backlinks-caret" });
		setIcon(caret, "chevron-down");
		heading.createSpan({ cls: "logseq-backlinks-title", text: opts.title });

		const body = section.createDiv({ cls: "logseq-backlinks-body" });
		if (opts.groups) this.renderGroups(body, opts.groups, view, state, opts.highlight);

		let loaded = !opts.lazyLoad;
		const ensureLoaded = async () => {
			if (loaded) return;
			loaded = true;
			const groups = await opts.lazyLoad!();
			if (groups.length === 0) {
				body.createDiv({
					cls: "logseq-backlinks-empty",
					text: "No unlinked references",
				});
			} else {
				this.renderGroups(body, groups, view, state, opts.highlight);
			}
		};

		const applyCollapsed = (c: boolean) => {
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

	private renderGroups(
		body: HTMLElement,
		groups: RefGroup[],
		view: MarkdownView,
		state: ViewState,
		highlight: string | null
	) {
		for (const group of groups) {
			const card = body.createDiv({ cls: "logseq-backlinks-card" });
			const pageLink = card.createDiv({
				cls: "logseq-backlinks-page",
				text: displayName(group.file),
				attr: { role: "link", tabindex: "0" },
			});
			const openPage = (evt: MouseEvent | KeyboardEvent) => {
				void this.app.workspace
					.getLeaf(Keymap.isModEvent(evt))
					.openFile(group.file);
			};
			pageLink.addEventListener("click", openPage);
			pageLink.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") openPage(evt);
			});

			for (const block of group.blocks) {
				const blockEl = card.createDiv({
					cls: "logseq-backlinks-block markdown-rendered",
				});
				void MarkdownRenderer.render(
					this.app,
					block.markdown,
					blockEl,
					group.file.path,
					state.component
				).then(() => {
					if (highlight) this.highlightText(blockEl, highlight);
				});

				blockEl.addEventListener("click", (evt) => {
					const target = evt.target as HTMLElement;
					if (target.closest("a")) return;
					if (window.getSelection()?.toString()) return;
					if (matchesJumpGesture(evt, this.settings.jumpGesture)) {
						// The configured gesture jumps to the block in its source.
						void this.app.workspace
							.getLeaf(false)
							.openFile(group.file, {
								eState: { line: block.startLine },
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

	private beginEdit(
		view: MarkdownView,
		state: ViewState,
		blockEl: HTMLElement,
		file: TFile,
		block: RefBlock
	) {
		if (state.editing || !blockEl.isConnected) return;
		state.editing = true;
		blockEl.addClass("is-editing");
		blockEl.empty();

		// Keys are handled through a pushed keymap Scope — the mechanism modals
		// use. A DOM listener is the wrong layer here: Obsidian's window-level
		// hotkey handler consumes Mod+Enter during the capture phase, before
		// the event ever reaches the editor. A pushed Scope is consulted by
		// that same handler, so it wins regardless of DOM position.
		const scope = new Scope(this.app.scope);
		this.app.keymap.pushScope(scope);
		let popped = false;
		const popScope = () => {
			if (popped) return;
			popped = true;
			this.app.keymap.popScope(scope);
		};
		state.component.register(popScope);

		// Shared teardown for both editor flavors: capture the value, tear the
		// editor down, save if changed, re-render.
		let done = false;
		const makeFinish =
			(getValue: () => string, cleanup: () => void) =>
			async (save: boolean) => {
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
		const bindKeys = (finish: (save: boolean) => Promise<void>) => {
			scope.register([], "Escape", () => {
				void finish(false);
				return false;
			});
			const shortcut = SAVE_SHORTCUT_KEYS[this.settings.saveShortcut];
			if (shortcut) {
				scope.register(shortcut.modifiers, shortcut.key, () => {
					void finish(true);
					return false;
				});
			}
		};

		const embedded = createEmbeddedEditor(this.app, blockEl, block.markdown);
		if (embedded) {
			state.component.register(() => embedded.destroy());
			const finish = makeFinish(
				() => embedded.value,
				() => embedded.destroy()
			);
			bindKeys(finish);
			blockEl.addEventListener("focusout", (evt) => {
				const to = evt.relatedTarget;
				if (!(to instanceof Node) || !blockEl.contains(to)) {
					void finish(true);
				}
			});
			window.requestAnimationFrame(() => embedded.focus());
			return;
		}

		// Fallback: plain textarea, if the private editor API ever changes.
		const ta = blockEl.createEl("textarea", {
			cls: "logseq-backlinks-editor",
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

		const finish = makeFinish(() => ta.value, () => {});
		bindKeys(finish);
		ta.addEventListener("blur", () => void finish(true));
	}

	private async saveBlock(file: TFile, block: RefBlock, newMarkdown: string) {
		await this.app.vault.process(file, (data) => {
			const lines = data.split("\n");
			const current = lines
				.slice(block.startLine, block.endLine + 1)
				.join("\n");
			if (current !== block.rawText) {
				new Notice(
					"This block changed in the meantime; nothing was saved."
				);
				return data;
			}
			const replacement = newMarkdown
				.split("\n")
				.map((l) => (l.length > 0 ? block.indent + l : l));
			lines.splice(
				block.startLine,
				block.endLine - block.startLine + 1,
				...replacement
			);
			return lines.join("\n");
		});
	}

	/** Make internal links rendered by MarkdownRenderer clickable + hoverable. */
	private wireLinks(el: HTMLElement, view: MarkdownView, sourcePath: string) {
		el.addEventListener("click", (evt) => {
			const link = (evt.target as HTMLElement).closest("a.internal-link");
			if (!link) return;
			evt.preventDefault();
			evt.stopPropagation();
			const href = link.getAttribute("data-href") ?? link.getAttribute("href");
			if (href) {
				void this.app.workspace.openLinkText(
					href,
					sourcePath,
					Keymap.isModEvent(evt)
				);
			}
		});
		el.addEventListener("mouseover", (evt) => {
			const link = (evt.target as HTMLElement).closest("a.internal-link");
			if (!link) return;
			this.app.workspace.trigger("hover-link", {
				event: evt,
				source: "preview",
				hoverParent: view,
				targetEl: link,
				linktext: link.getAttribute("data-href") ?? link.getAttribute("href"),
				sourcePath,
			});
		});
	}

	private highlightText(el: HTMLElement, needle: string) {
		const re = new RegExp(escapeRegex(needle), "gi");
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const textNodes: Text[] = [];
		let node: Node | null;
		while ((node = walker.nextNode())) textNodes.push(node as Text);
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

	private async collectLinkedReferences(target: TFile): Promise<RefGroup[]> {
		const resolved = this.app.metadataCache.resolvedLinks;
		const groups: RefGroup[] = [];

		for (const sourcePath of Object.keys(resolved)) {
			if (sourcePath === target.path) continue;
			if (!resolved[sourcePath]?.[target.path]) continue;
			const source = this.app.vault.getAbstractFileByPath(sourcePath);
			if (!(source instanceof TFile)) continue;
			const cache = this.app.metadataCache.getFileCache(source);
			if (!cache) continue;

			const refs = [...(cache.links ?? []), ...(cache.embeds ?? [])].filter(
				(ref) => {
					const dest = this.app.metadataCache.getFirstLinkpathDest(
						getLinkpath(ref.link),
						sourcePath
					);
					return dest?.path === target.path;
				}
			);
			if (refs.length === 0) continue;

			const lines = (await this.app.vault.cachedRead(source)).split("\n");
			const seen = new Map<string, RefBlock>();
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

	private async collectUnlinkedReferences(
		target: TFile,
		linkedRanges: Map<string, Array<[number, number]>>
	): Promise<RefGroup[]> {
		const name = target.basename;
		if (name.length < 2) return [];
		const re = new RegExp(
			`(^|[^\\w\\[])(${escapeRegex(name)})([^\\w\\]]|$)`,
			"i"
		);
		const groups: RefGroup[] = [];
		const files = this.app.vault.getMarkdownFiles();
		let scanned = 0;

		for (const source of files) {
			if (source.path === target.path) continue;
			if (++scanned > 2000 || groups.length >= 50) break;
			const content = await this.app.vault.cachedRead(source);
			if (!re.test(content)) continue;

			const cache = this.app.metadataCache.getFileCache(source);
			if (!cache) continue;
			const covered = linkedRanges.get(source.path) ?? [];
			const lines = content.split("\n");
			const seen = new Map<string, RefBlock>();
			for (let i = 0; i < lines.length; i++) {
				if (!re.test(lines[i])) continue;
				const range = this.blockRangeForLine(cache, i);
				// Content already shown under Linked References — the same
				// block, or a sub-bullet of a linked block — is not an
				// unlinked mention.
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
					blocks: [...seen.values()].sort((a, b) => a.startLine - b.startLine),
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
	private blockRangeForLine(
		cache: CachedMetadata,
		line: number
	): { start: number; end: number } {
		const items = cache.listItems ?? [];
		let best: (typeof items)[number] | null = null;
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
				// Walk the parent chain to see if `best` is an ancestor.
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
				// A list starting on the very next line (no blank line between)
				// belongs to this line, Logseq style: the line is the parent,
				// the bullets underneath are its children.
				const next = sections[i + 1];
				if (
					sections[i].type !== "list" &&
					next?.type === "list" &&
					next.position.start.line === e + 1
				) {
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
	private extractBlock(lines: string[], start: number, end: number): RefBlock {
		const raw = lines.slice(start, end + 1);
		const indent = /^[\t ]*/.exec(raw[0])?.[0] ?? "";
		const dedented = raw.map((l) =>
			l.startsWith(indent) ? l.slice(indent.length) : l.trimStart()
		);
		return {
			startLine: start,
			endLine: end,
			markdown: dedented.join("\n"),
			rawText: raw.join("\n"),
			indent,
		};
	}

	/** Journals first, newest first — like Logseq — then other pages A-Z. */
	private sortGroups(groups: RefGroup[]): RefGroup[] {
		return groups.sort((a, b) => {
			const da = journalDate(a.file);
			const db = journalDate(b.file);
			if (da !== null && db !== null) return db - da;
			if (da !== null) return -1;
			if (db !== null) return 1;
			return a.file.basename.localeCompare(b.file.basename);
		});
	}
}

class LogseqBacklinksSettingTab extends PluginSettingTab {
	constructor(private plugin: LogseqBacklinksPlugin) {
		super(plugin.app, plugin);
	}

	display(): void {
		this.containerEl.empty();

		new Setting(this.containerEl)
			.setName("Save shortcut")
			.setDesc(
				"Keyboard shortcut that saves an inline block edit back to the " +
					"source note. Clicking away always saves; Esc always cancels."
			)
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(SAVE_SHORTCUT_LABELS)) {
					dropdown.addOption(value, label);
				}
				dropdown
					.setValue(this.plugin.settings.saveShortcut)
					.onChange(async (value) => {
						this.plugin.settings.saveShortcut = value as SaveShortcut;
						await this.plugin.saveData(this.plugin.settings);
					});
			});

		new Setting(this.containerEl)
			.setName("Jump to source")
			.setDesc(
				"Click gesture that opens a reference block in its source note. " +
					"A plain click always edits the block in place, like Logseq."
			)
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(JUMP_GESTURE_LABELS)) {
					dropdown.addOption(value, label);
				}
				dropdown
					.setValue(this.plugin.settings.jumpGesture)
					.onChange(async (value) => {
						this.plugin.settings.jumpGesture = value as JumpGesture;
						await this.plugin.saveData(this.plugin.settings);
					});
			});
	}
}
