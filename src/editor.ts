import { App } from "obsidian";

/**
 * A real Obsidian markdown editor (with Live Preview) embedded in an
 * arbitrary element — the same widget Obsidian uses for Canvas cards.
 *
 * Obsidian has no public API for this, so the editor class is resolved from
 * a throwaway markdown embed, the pattern community plugins (Kanban, Hover
 * Editor, ...) rely on. Callers must handle `null` (private API changed)
 * and fall back to something simpler.
 */
export interface EmbeddedEditor {
	readonly value: string;
	focus(): void;
	destroy(): void;
}

let editorClass: any = null;

function resolveEditorClass(app: App): any {
	if (editorClass) return editorClass;
	const embed = (app as any).embedRegistry.embedByExtension.md(
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

export function createEmbeddedEditor(
	app: App,
	container: HTMLElement,
	initialValue: string
): EmbeddedEditor | null {
	try {
		const EditorClass = resolveEditorClass(app);
		const owner: any = {
			app,
			onMarkdownScroll: () => {},
			getMode: () => "source",
		};
		const editor = new EditorClass(app, container, owner);
		owner.editMode = editor;
		// Workspace event handlers (e.g. editor-selection-change) expect the
		// owning "view" to expose the Editor facade.
		Object.defineProperty(owner, "editor", {
			get: () => editor.editor,
			configurable: true,
		});
		editor.set(initialValue, true);

		const cm = () => editor.cm ?? editor.editor?.cm;
		let destroyed = false;
		return {
			get value(): string {
				return (
					cm()?.state?.doc?.toString() ?? editor.editor?.getValue() ?? initialValue
				);
			},
			focus() {
				const view = cm();
				if (view) {
					view.focus();
					// Cursor at the end, like clicking into the end of a block.
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
			},
		};
	} catch (error) {
		console.error(
			"logseq-backlinks: embedded live-preview editor unavailable, falling back to plain editor",
			error
		);
		return null;
	}
}
