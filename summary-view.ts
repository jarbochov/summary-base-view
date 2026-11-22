import {
	BooleanValue,
	BasesEntry,
	BasesPropertyId,
	BasesView,
	BasesViewConfig,
	DateValue,
	DurationValue,
	ListValue,
	LinkValue,
	Menu,
	Modal,
	NullValue,
	Notice,
	Platform,
	NumberValue,
	parseYaml,
	QueryController,
	RenderContext,
	setIcon,
	Setting,
	StringValue,
	TFile,
	Value,
} from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { createFormulaEditor, PRESET_SUMMARY_FORMULAS } from './formula-editor';
import {
	buildSummaryColumns,
	buildSummaryRows,
	COUNT_COLUMN_ID,
	COUNT_SUMMARIES,
	COUNT_SUMMARY_NONE,
	summarizeCounts,
	readSummaryColumns,
	summaryColumnsToConfig,
	syncSummaryColumnsOrder,
	type SummaryColumn,
	type SummaryColumnConfig,
	type SummaryRow,
	type SummarySortKey,
	expandSummaryGroups,
	normalizePropertyId,
	normalizeSummaryConfig,
	readSummaryConfig,
	serializeCsv,
	serializeMarkdownTable,
	sortSummaryRows,
	isExcludedPath,
} from './summary-core';

export const SUMMARY_VIEW_TYPE = 'summary-base-view';
const DATE_RANGE_SUMMARY = 'Date range';
type DurationMode = 'sum' | 'mean' | 'max' | 'min';
const DURATION_SUMMARIES: Readonly<Record<string, { unit: number; mode: DurationMode }>> = {
	'Total hours': { unit: 3_600_000, mode: 'sum' },
	'Total days': { unit: 86_400_000, mode: 'sum' },
	'Total minutes': { unit: 60_000, mode: 'sum' },
	'Average hours': { unit: 3_600_000, mode: 'mean' },
	'Average days': { unit: 86_400_000, mode: 'mean' },
	'Longest (hours)': { unit: 3_600_000, mode: 'max' },
	'Shortest (hours)': { unit: 3_600_000, mode: 'min' },
};

function isDurationValue(value: Value | null | undefined): boolean {
	return value instanceof DurationValue
		|| (Boolean(value) && !(value instanceof DateValue)
			&& typeof (value as { getMilliseconds?: unknown }).getMilliseconds === 'function');
}
const DATE_RANGE_FORMULA = 'values.earliest().format("YYYY-MM-DD") + " ~ " + values.latest().format("YYYY-MM-DD")';
export const SHOW_SUMMARY_ROW_KEY = 'showSummaryRow';
export const SHOW_EMPTY_GROUP_KEY = 'showEmptyGroup';
const SUMMARY_SORT_KEY = 'summarySort';
const GROUP_SIZE_KEY = '$group';
const MIN_COLUMN_WIDTH = 60;
const MAX_AUTO_COLUMN_WIDTH = 480;

interface ParsedViewSettings {
	groupByProperty: string | null;
	groupDirection: 'ASC' | 'DESC';
	groupOrder: string[];
	sort: Array<{ property: string; direction: 'ASC' | 'DESC' }>;
	summaries: Record<string, string>;
	summaryColumns: SummaryColumnConfig[] | null;
	customSummaries: Record<string, string>;
	columnSize: Record<string, number>;
}

interface ActiveSort {
	target: string;
	direction: 'ASC' | 'DESC';
}

interface SummarySortSetting {
	property: BasesPropertyId;
	direction: 'ASC' | 'DESC';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseViewSettings(source: string, viewName: string): ParsedViewSettings | null {
	const parsed: unknown = parseYaml(source);
	if (!isRecord(parsed) || !Array.isArray(parsed.views)) {
		return null;
	}

	const candidates = parsed.views.filter(
		(view): view is Record<string, unknown> => isRecord(view) && view.type === SUMMARY_VIEW_TYPE,
	);
	const view = candidates.find((candidate) => candidate.name === viewName)
		?? (candidates.length === 1 ? candidates[0] : null);
	if (!view) {
		return null;
	}

	const groupBy = isRecord(view.groupBy) ? view.groupBy : {};
	const columnSize = isRecord(view.columnSize)
		? Object.fromEntries(
			Object.entries(view.columnSize).filter(
				(entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0,
			),
		)
		: {};
	return {
		groupByProperty: typeof groupBy.property === 'string' ? groupBy.property : null,
		groupDirection: groupBy.direction === 'DESC' ? 'DESC' : 'ASC',
		groupOrder: Array.isArray(view.groupOrder)
			? view.groupOrder.map((value) => String(value))
			: [],
		sort: Array.isArray(view.sort)
			? view.sort.flatMap((item) =>
				isRecord(item)
					&& typeof item.property === 'string'
					&& (item.direction === 'ASC' || item.direction === 'DESC')
					? [{ property: item.property, direction: item.direction }]
					: [],
			)
			: [],
		summaries: readSummaryConfig(view.summaries),
		summaryColumns: readSummaryColumns(view.summaryColumns),
		customSummaries: readSummaryConfig(parsed.summaries),
		columnSize,
	};
}

function findSummaryEntrySpan(
	lines: readonly string[],
	summariesIndex: number,
	end: number,
	name: string,
): { start: number; count: number } | null {
	const quoted = JSON.stringify(name);
	const singleQuoted = `'${name.replace(/'/g, "''")}'`;
	for (let i = summariesIndex + 1; i < end; i += 1) {
		const line = lines[i];
		const indentMatch = /^(\s+)/.exec(line);
		if (!indentMatch) {
			continue;
		}
		const trimmed = line.trim();
		if (trimmed.startsWith(`${quoted}:`) || trimmed.startsWith(`${name}:`) || trimmed.startsWith(`${singleQuoted}:`)) {
			const baseIndent = indentMatch[1].length;
			let count = 1;
			while (i + count < end) {
				const next = lines[i + count];
				const nextIndent = /^(\s*)/.exec(next)?.[1].length ?? 0;
				if (next.trim().length > 0 && nextIndent <= baseIndent) {
					break;
				}
				count += 1;
			}
			return { start: i, count };
		}
	}
	return null;
}

function getSummariesBlockBounds(lines: readonly string[]): { index: number; end: number } | null {
	const summariesIndex = lines.findIndex((line) => /^summaries\s*:\s*(?:#.*)?$/.test(line));
	if (lines.some((line) => /^summaries\s*:\s*\S/.test(line) && summariesIndex < 0)) {
		throw new Error('The summaries section of this Base is written inline and cannot be edited automatically.');
	}
	if (summariesIndex < 0) {
		return null;
	}
	let end = summariesIndex + 1;
	while (end < lines.length && (lines[end].trim().length === 0 || /^\s/.test(lines[end]))) {
		end += 1;
	}
	while (end > summariesIndex + 1 && lines[end - 1].trim().length === 0) {
		end -= 1;
	}
	return { index: summariesIndex, end };
}

function upsertCustomSummaryDefinition(source: string, name: string, formula: string): string {
	const lines = source.split(/\r?\n/);
	const entry = `  ${JSON.stringify(name)}: ${JSON.stringify(formula)}`;
	const emptyInline = lines.findIndex((line) => /^summaries\s*:\s*\{\s*\}\s*(?:#.*)?$/.test(line));
	if (emptyInline >= 0) {
		lines.splice(emptyInline, 1, 'summaries:', entry);
		return lines.join('\n');
	}
	const bounds = getSummariesBlockBounds(lines);
	if (bounds) {
		const span = findSummaryEntrySpan(lines, bounds.index, bounds.end, name);
		if (span) {
			lines.splice(span.start, span.count, entry);
		} else {
			lines.splice(bounds.end, 0, entry);
		}
		return lines.join('\n');
	}
	const viewsIndex = lines.findIndex((line) => /^views\s*:\s*(?:#.*)?$/.test(line));
	if (viewsIndex < 0) {
		throw new Error('Could not locate the views section in the active Base.');
	}
	lines.splice(viewsIndex, 0, 'summaries:', entry);
	return lines.join('\n');
}

function deleteCustomSummaryDefinition(source: string, name: string): string {
	const lines = source.split(/\r?\n/);
	const bounds = getSummariesBlockBounds(lines);
	if (!bounds) {
		return source;
	}
	const span = findSummaryEntrySpan(lines, bounds.index, bounds.end, name);
	if (!span) {
		return source;
	}
	lines.splice(span.start, span.count);
	const remaining = lines.slice(bounds.index + 1, bounds.end - span.count).some((line) => line.trim().length > 0);
	if (!remaining) {
		lines.splice(bounds.index, 1);
	}
	return lines.join('\n');
}

interface SummaryModalOptions {
	existingNames: ReadonlySet<string>;
	initialName?: string;
	onSubmit: (name: string, formula: string) => void;
	onDelete?: (name: string) => void;
	edit?: { name: string; formula: string };
	choices?: readonly string[];
	onChoose?: (name: string) => void;
}

class AddSummaryModal extends Modal {
	private name: string;
	private formula: string;
	private editor: EditorView | null = null;

	constructor(app: Modal['app'], private readonly options: SummaryModalOptions) {
		super(app);
		this.name = options.edit?.name ?? options.initialName ?? '';
		this.formula = options.edit?.formula ?? '';
	}

	onOpen(): void {
		const edit = this.options.edit;
		this.setTitle(edit ? 'Edit summary' : 'Add summary');
		this.modalEl.addClass('summary-base-view-summary-modal');
		const { choices, onChoose, onDelete } = this.options;
		if (edit && choices && onChoose) {
			new Setting(this.contentEl)
				.setName('Switch summary')
				.setDesc('Use a different built-in or custom summary for this column.')
				.addDropdown((dropdown) => {
					for (const choice of choices) {
						dropdown.addOption(choice, choice);
					}
					dropdown.setValue(edit.name).onChange((value) => {
						this.close();
						onChoose(value);
					});
				});
		}
		let nameInputEl: HTMLInputElement | null = null;
		new Setting(this.contentEl)
			.setName('Name')
			.addText((text) => {
				nameInputEl = text.inputEl;
				text.setPlaceholder('Total').setValue(this.name).onChange((value) => {
					this.name = value.trim();
				});
				text.setDisabled(Boolean(edit));
				text.inputEl.addEventListener('keydown', (event) => {
					if (event.key === 'Enter' && !event.isComposing) {
						event.preventDefault();
						this.editor?.focus();
					}
				});
			});
		const formulaSetting = new Setting(this.contentEl)
			.setName('Formula')
			.setDesc('Use values for the column values. Type to see suggestions, for example values.sum() or values.mean().round(2).');
		formulaSetting.settingEl.addClass('summary-base-view-formula-setting');
		const editorEl = formulaSetting.controlEl.createDiv('summary-base-view-formula-editor');
		this.editor = createFormulaEditor(editorEl, {
			initialValue: this.formula,
			placeholder: 'values.sum()',
			onChange: (value) => {
				this.formula = value.trim();
			},
			onSubmit: () => this.submit(),
		});
		const actions = new Setting(this.contentEl);
		actions.settingEl.addClass('summary-base-view-modal-actions');
		if (edit && onDelete) {
			actions.addButton((button) => {
				button
					.setButtonText('Delete')
					.onClick(() => {
						this.close();
						onDelete(edit.name);
					});
				button.buttonEl.addClass('mod-warning');
			});
		}
		actions.addButton((button) => button
			.setButtonText('Cancel')
			.onClick(() => this.close()));
		actions.addButton((button) => button
			.setButtonText(edit ? 'Save' : 'Add')
			.setCta()
			.onClick(() => this.submit()));

		window.setTimeout(() => {
			if (edit || this.name) {
				this.editor?.focus();
			} else {
				nameInputEl?.focus();
			}
		}, 0);
	}

	private submit(): void {
		if (!this.name || !this.formula) {
			new Notice('Enter a name and a formula.');
			return;
		}
		if (!this.options.edit && this.options.existingNames.has(this.name)) {
			new Notice(`A summary named "${this.name}" already exists.`);
			return;
		}
		this.close();
		this.options.onSubmit(this.name, this.formula);
	}

	onClose(): void {
		this.editor?.destroy();
		this.editor = null;
		this.contentEl.empty();
	}
}

function readColumnSize(value: unknown): Record<string, number> | null {
	if (!isRecord(value)) {
		return null;
	}
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0,
		),
	);
}

function normalizeProperties(values: readonly string[], availableProperties: readonly string[]): string[] {
	return values.flatMap((property) => {
		const propertyId = normalizePropertyId(property, availableProperties);
		return propertyId ? [propertyId] : [];
	});
}

function renderValue(container: HTMLElement, value: Value | null, context: RenderContext): void {
	if (value) {
		value.renderTo(container, context);
	}
}

function builtinSummaryFormula(key: string, example: Value | null | undefined): string {
	if (key === DATE_RANGE_SUMMARY) {
		return DATE_RANGE_FORMULA;
	}
	if (key === 'Range' && example instanceof DateValue) {
		return '(values.latest() - values.earliest())';
	}
	return PRESET_SUMMARY_FORMULAS[key] ?? '';
}

function summaryOptions(value: Value | null, customSummaries: Readonly<Record<string, string>>): string[] {
	let options: string[];
	if (value instanceof NumberValue) {
		options = ['Average', 'Min', 'Max', 'Sum', 'Range', 'Median', 'Stddev', 'Empty', 'Filled', 'Unique'];
	} else if (value instanceof DateValue) {
		options = ['Earliest', 'Latest', DATE_RANGE_SUMMARY, 'Range', 'Empty', 'Filled', 'Unique'];
	} else if (isDurationValue(value)) {
		options = [...Object.keys(DURATION_SUMMARIES), 'Empty', 'Filled', 'Unique'];
	} else if (value instanceof BooleanValue) {
		options = ['Checked', 'Unchecked', 'Empty', 'Filled', 'Unique'];
	} else {
		options = ['Empty', 'Filled', 'Unique'];
	}

	return [...new Set([...options, ...Object.keys(customSummaries)])];
}

// Bases keeps the real sort and groupBy outside of config.get/set, and the native Sort and Group menus read them.
interface NativeViewConfig {
	groupBy?: { property?: unknown; direction?: unknown } | null;
	setGroupBy?: (groupBy: { property: string; direction: 'ASC' | 'DESC' } | null) => void;
	setOrder?: (order: BasesPropertyId[]) => void;
	setSortProperty?: (property: string, direction: 'ASC' | 'DESC' | 'NONE') => void;
}

function readNativeGroupBy(config: BasesViewConfig): unknown {
	const groupBy = (config as unknown as NativeViewConfig).groupBy;
	return groupBy ?? undefined;
}

function writeNativeGroupBy(config: BasesViewConfig, groupBy: { property: string; direction: 'ASC' | 'DESC' }): void {
	const native = config as unknown as NativeViewConfig;
	if (typeof native.setGroupBy === 'function') {
		native.setGroupBy(groupBy);
	} else {
		config.set('groupBy', groupBy);
	}
}

function writeNativeOrder(config: BasesViewConfig, order: BasesPropertyId[]): void {
	const native = config as unknown as NativeViewConfig;
	if (typeof native.setOrder === 'function') {
		native.setOrder(order);
	} else {
		config.set('order', order);
	}
}

function writeNativeSort(config: BasesViewConfig, sorts: SummarySortSetting[]): void {
	const native = config as unknown as NativeViewConfig;
	if (typeof native.setSortProperty !== 'function') {
		config.set('sort', sorts);
		return;
	}
	for (const existing of config.getSort()) {
		if (!sorts.some((sort) => sort.property === existing.property)) {
			native.setSortProperty(existing.property, 'NONE');
		}
	}
	for (const sort of [...sorts].reverse()) {
		native.setSortProperty(sort.property, sort.direction);
	}
}

interface ElectronClipboard {
	writeText(text: string): void;
}

// The web clipboard API can resolve without writing when the window lacks user activation, so prefer Electron's clipboard on desktop.
async function copyText(text: string): Promise<boolean> {
	if (Platform.isDesktopApp) {
		try {
			const electron = (window as unknown as { require?: (id: string) => { clipboard?: ElectronClipboard } }).require?.('electron');
			if (electron?.clipboard) {
				electron.clipboard.writeText(text);
				return true;
			}
		} catch {
			// Fall back to the web clipboard API.
		}
	}
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

interface TableLayoutRefs {
	groupByProperty: BasesPropertyId | null;
	columns: SummaryColumn[];
	head: HTMLElement;
	tableContainer: HTMLElement;
	table: HTMLElement;
	body: HTMLElement;
	footer: HTMLElement;
	widths: number[];
}

export class SummaryBasesView extends BasesView {
	readonly type = SUMMARY_VIEW_TYPE;

	private readonly queryController: QueryController;
	private readonly rootEl: HTMLElement;
	private readonly renderContext = new RenderContext();
	private sizeOverride: Record<string, number> = {};
	private customSummaryNames = new Set<string>();
	private pendingSummary: { apply: () => void; timer: number } | null = null;
	private columnOverride: SummaryColumnConfig[] | null = null;
	private lastOrderSignature: string | null = null;
	private currentColumns: SummaryColumn[] = [];
	private currentGroupBy: string | null = null;
	private currentSorts: SummarySortSetting[] = [];
	private currentCsv = '';
	private currentMarkdown = '';
	private activeSort: ActiveSort | null = null;
	private configSortSignature: string | null = null;
	private pendingSortSignature: string | null = null;
	private renderSequence = 0;
	private tableLayout: TableLayoutRefs | null = null;
	private toolbarEl: HTMLElement | null = null;
	private resultCountEl: HTMLElement | null = null;
	private groupCountLabelEl: HTMLElement | null = null;
	private sortBadgeEl: HTMLElement | null = null;
	private originalSortBadgeText = '';
	private originalSortBadgeDisplay = '';

	constructor(
		controller: QueryController,
		parentEl: HTMLElement,
		private readonly getExcludedFolders: () => string[],
	) {
		super(controller);
		this.queryController = controller;
		this.rootEl = parentEl.createDiv('summary-base-view');
		this.register(() => this.detachToolbar());
	}

	private getBaseFile(): TFile | null {
		const controllerFile = (this.queryController as unknown as { query?: { file?: unknown } }).query?.file;
		if (controllerFile instanceof TFile && controllerFile.extension === 'base') {
			return controllerFile;
		}
		const embedSrc = this.rootEl.closest('.internal-embed')?.getAttribute('src');
		const activeFile = this.app.workspace.getActiveFile();
		if (embedSrc) {
			const linkTarget = embedSrc.split('#')[0];
			const resolved = this.app.metadataCache.getFirstLinkpathDest(linkTarget, activeFile?.path ?? '');
			if (resolved instanceof TFile && resolved.extension === 'base') {
				return resolved;
			}
		}
		return activeFile?.extension === 'base' ? activeFile : null;
	}

	private getDateRange(entries: BasesEntry[], propertyId: BasesPropertyId): Value {
		const format = (value: Value): string | null => {
			if (!(value instanceof DateValue)) {
				return null;
			}
			const text = value.toString();
			return /\d{4}-\d{2}-\d{2}/.exec(text)?.[0] ?? text;
		};
		const earliest = format(this.data.getSummaryValue(this.queryController, entries, propertyId, 'Earliest'));
		const latest = format(this.data.getSummaryValue(this.queryController, entries, propertyId, 'Latest'));
		return earliest && latest ? new StringValue(`${earliest} ~ ${latest}`) : NullValue.value;
	}

	private getDurationSummary(entries: BasesEntry[], propertyId: BasesPropertyId, summaryKey: string): Value {
		const { unit, mode } = DURATION_SUMMARIES[summaryKey];
		let count = 0;
		let total = 0;
		let max = -Infinity;
		let min = Infinity;
		for (const entry of entries) {
			const value = entry.getValue(propertyId);
			if (!isDurationValue(value)) {
				continue;
			}
			const ms = (value as unknown as { getMilliseconds: () => number }).getMilliseconds();
			count += 1;
			total += ms;
			if (ms > max) {
				max = ms;
			}
			if (ms < min) {
				min = ms;
			}
		}
		if (count === 0) {
			return NullValue.value;
		}
		const result = mode === 'max' ? max
			: mode === 'min' ? min
				: mode === 'mean' ? total / count : total;
		return new NumberValue(Math.round((result / unit) * 100) / 100);
	}

	private getSummaryValue(entries: BasesEntry[], propertyId: BasesPropertyId, summaryKey: string): Value {
		if (summaryKey in DURATION_SUMMARIES && !this.customSummaryNames.has(summaryKey)) {
			return this.getDurationSummary(entries, propertyId, summaryKey);
		}
		if (summaryKey === DATE_RANGE_SUMMARY && !this.customSummaryNames.has(summaryKey)) {
			return this.getDateRange(entries, propertyId);
		}
		const value = this.data.getSummaryValue(this.queryController, entries, propertyId, summaryKey);
		if (!(value instanceof DateValue)) {
			return value;
		}
		// Date-only properties should not gain a midnight time from Earliest/Latest.
		const hasTime = entries.some((entry) => {
			const source = entry.getValue(propertyId);
			return source instanceof DateValue && /\d:\d\d/.test(source.toString());
		});
		return hasTime ? value : value.dateOnly();
	}

	private isExcluded(entry: BasesEntry): boolean {
		return isExcludedPath(entry.file.path, this.getExcludedFolders());
	}

	private getSortKey(value: Value | null): SummarySortKey {
		if (value === null || value instanceof NullValue) {
			return { empty: true, text: '' };
		}
		if (value instanceof NumberValue) {
			const text = value.toString();
			const parsed = Number(text);
			return { empty: false, num: Number.isFinite(parsed) ? parsed : undefined, text };
		}
		if (isDurationValue(value)) {
			const ms = (value as unknown as { getMilliseconds: () => number }).getMilliseconds();
			return { empty: false, num: ms, text: value.toString() };
		}
		if (value instanceof DateValue) {
			const text = value.toString();
			const parsed = Date.parse(text);
			return { empty: false, num: Number.isFinite(parsed) ? parsed : undefined, text };
		}
		const text = value.toString();
		return { empty: text.length === 0, text };
	}

	public onDataUpdated(): void {
		const pending = this.pendingSummary;
		if (pending) {
			window.setTimeout(pending.apply, 300);
		}
		this.render().catch((error: unknown) => {
			console.error('Simple Summary Base View: failed to render', error);
			this.rootEl.empty();
			this.tableLayout = null;
			this.updateNativeToolbar(0);
			this.rootEl.createDiv({
				cls: 'summary-base-view-error',
				text: 'Failed to render this summary. See the developer console for details.',
			});
		});
	}

	private async render(): Promise<void> {
		const sequence = ++this.renderSequence;
		const prevScrollTop = this.rootEl.scrollTop;
		const prevScrollLeft = this.rootEl.scrollLeft;

		const orderedProperties = this.config.getOrder();
		const baseFile = this.getBaseFile();
		const source = baseFile ? await this.app.vault.cachedRead(baseFile) : null;
		if (sequence !== this.renderSequence) {
			return;
		}

		this.rootEl.empty();
		this.tableLayout = null;
		this.currentCsv = '';
		this.currentMarkdown = '';

		const settings = source ? parseViewSettings(source, this.config.name) : null;
		const configuredGroupBy = readNativeGroupBy(this.config);
		const rawGroupBy = configuredGroupBy ?? settings?.groupByProperty;
		const rawGroupByProperty = isRecord(rawGroupBy)
			? rawGroupBy.property ?? rawGroupBy.propertyId
			: rawGroupBy;
		const availablePropertySet = new Set<string>([...orderedProperties, ...this.data.properties]);
		if (typeof rawGroupByProperty === 'string') {
			availablePropertySet.add(rawGroupByProperty);
			if (!rawGroupByProperty.startsWith('file.')
				&& !rawGroupByProperty.startsWith('formula.')
				&& !rawGroupByProperty.startsWith('note.')) {
				availablePropertySet.add(`note.${rawGroupByProperty}`);
			}
		}
		const availableProperties = [...availablePropertySet];
		const groupByProperty = normalizePropertyId(
			rawGroupByProperty,
			availableProperties,
		) as BasesPropertyId | null;
		const summaries = normalizeSummaryConfig(
			this.config.get('summaries') ?? settings?.summaries,
			availableProperties,
		);
		const properties = orderedProperties.length > 0
			? normalizeProperties(orderedProperties, availableProperties)
			: this.data.properties;
		const orderSignature = JSON.stringify(properties);
		let storedColumns = readSummaryColumns(this.config.get('summaryColumns')) ?? settings?.summaryColumns ?? null;
		if (this.lastOrderSignature !== null && this.lastOrderSignature !== orderSignature && storedColumns && !this.columnOverride) {
			const synced = syncSummaryColumnsOrder(storedColumns, properties, availableProperties);
			if (JSON.stringify(synced) !== JSON.stringify(storedColumns)) {
				storedColumns = synced;
				this.columnOverride = synced;
				this.config.set('summaryColumns', synced);
			}
		}
		this.lastOrderSignature = orderSignature;
		if (this.columnOverride && storedColumns
			&& JSON.stringify(storedColumns) === JSON.stringify(this.columnOverride)) {
			this.columnOverride = null;
		}
		const columns = buildSummaryColumns(
			properties,
			groupByProperty,
			summaries,
			this.columnOverride ?? storedColumns,
			availableProperties,
		);
		this.currentColumns = columns;
		this.currentGroupBy = groupByProperty;

		const showEmptyGroup = this.config.get(SHOW_EMPTY_GROUP_KEY) === true;
		const groupedData = expandSummaryGroups(
			this.data.groupedData,
			(key) => {
				if (!(key instanceof ListValue)) {
					return key instanceof NullValue ? [] : [key];
				}

				const values: Value[] = [];
				for (let index = 0; index < key.length(); index += 1) {
					const value = key.get(index);
					if (!(value instanceof NullValue) && !values.some((existing) => Value.equals(existing, value))) {
						values.push(value);
					}
				}
				return values;
			},
			(left, right) => Value.equals(left, right),
			showEmptyGroup ? NullValue.value : undefined,
		);
		const rows = buildSummaryRows<BasesEntry, Value, Value>(
			groupedData,
			columns,
			(entries, propertyId, summaryKey) =>
				this.getSummaryValue([...entries], propertyId as BasesPropertyId, summaryKey),
			(entry) => this.isExcluded(entry),
			showEmptyGroup,
		);
		const rawSorts = this.config.getSort();
		const configSorts = rawSorts.flatMap((sort) => {
			const property = normalizePropertyId(sort.property, availableProperties);
			return property && (sort.direction === 'ASC' || sort.direction === 'DESC')
				? [{ property: property as BasesPropertyId, direction: sort.direction }]
				: [];
		});
		const signature = JSON.stringify(configSorts);
		const savedSummarySort = this.readSavedSummarySort();
		if (signature !== this.configSortSignature) {
			// The saved Base lags behind header clicks, so only adopt it when it actually changes.
			this.configSortSignature = signature;
			if (signature === this.pendingSortSignature) {
				this.pendingSortSignature = null;
			} else {
				const first = configSorts[0];
				const target = first && first.property !== groupByProperty
					? columns.find((column) => column.propertyId === first.property)
					: undefined;
				this.activeSort = first && target
					? { target: target.id, direction: first.direction }
					: savedSummarySort;
			}
		} else if (!this.activeSort && savedSummarySort) {
			this.activeSort = savedSummarySort;
		}
		const sortColumn = this.activeSort && this.activeSort.target !== COUNT_COLUMN_ID
			? columns.findIndex((column) => column.id === this.activeSort?.target)
			: -1;
		if (this.activeSort && this.activeSort.target !== COUNT_COLUMN_ID && sortColumn < 0) {
			this.activeSort = null;
		}
		const sortedColumn = sortColumn >= 0 ? columns[sortColumn] : null;
		this.currentSorts = this.activeSort && sortedColumn?.propertyId && sortedColumn.id === sortedColumn.propertyId
			? [{ property: sortedColumn.propertyId as BasesPropertyId, direction: this.activeSort.direction }]
			: !this.activeSort && configSorts[0]?.property === groupByProperty ? [configSorts[0]] : [];
		const groupDirection = isRecord(rawGroupBy) && rawGroupBy.direction === 'DESC'
			? 'DESC'
			: isRecord(rawGroupBy) && rawGroupBy.direction === 'ASC'
				? 'ASC'
				: settings?.groupDirection ?? 'ASC';
		const sortedRows = sortSummaryRows(
			rows,
			(value) => value instanceof Value && !(value instanceof NullValue) ? value.toString() : '',
			{
				direction: groupDirection,
				groupOrder: settings?.groupOrder,
				columnIndex: this.activeSort && sortColumn >= 0 ? sortColumn : undefined,
				columnDirection: this.activeSort?.direction,
				countDirection: this.activeSort?.target === COUNT_COLUMN_ID ? this.activeSort.direction : undefined,
				getSortKey: (value) => this.getSortKey(value),
			},
		);
		this.updateNativeToolbar(sortedRows.length);

		const headers = [
			groupByProperty ? this.config.getDisplayName(groupByProperty) : 'Group',
			...columns.map((column) => this.getColumnLabel(column, columns)),
		];
		const exportRows = sortedRows.map((row) => [
			row.key instanceof NullValue ? '(Empty)' : row.key.toString(),
			...columns.map((column, index) => {
				if (column.propertyId === null) {
					return String(row.count);
				}
				const val = row.values[index];
				return val && !(val instanceof NullValue) ? val.toString() : '';
			}),
		]);
		this.currentCsv = serializeCsv(headers, exportRows);
		this.currentMarkdown = serializeMarkdownTable(headers, exportRows);

		if (sortedRows.length === 0) {
			this.rootEl.createDiv({
				cls: 'summary-base-view-empty',
				text: groupByProperty
					? 'No grouped notes to summarize.'
					: 'Choose a group-by property in the Base view settings.',
			});
			return;
		}
		const groupedEntrySet = new Set<BasesEntry>();
		for (const row of sortedRows) {
			for (const entry of row.entries ?? []) {
				groupedEntrySet.add(entry);
			}
		}
		const footerEntries = [...groupedEntrySet];
		this.renderTable(
			groupByProperty,
			groupDirection,
			columns,
			settings?.customSummaries ?? {},
			readColumnSize(this.config.get('columnSize')) ?? settings?.columnSize ?? {},
			sortedRows,
			footerEntries,
			headers,
		);
		this.rootEl.scrollTop = prevScrollTop;
		this.rootEl.scrollLeft = prevScrollLeft;
	}

	private readSavedSummarySort(): ActiveSort | null {
		const raw = this.config.get(SUMMARY_SORT_KEY);
		if (!isRecord(raw) || typeof raw.target !== 'string') {
			return null;
		}
		if (raw.direction !== 'ASC' && raw.direction !== 'DESC') {
			return null;
		}
		return { target: raw.target, direction: raw.direction };
	}

	private renderTable(
		groupByProperty: BasesPropertyId | null,
		groupDirection: 'ASC' | 'DESC',
		columns: SummaryColumn[],
		customSummaries: Readonly<Record<string, string>>,
		columnSize: Readonly<Record<string, number>>,
		rows: SummaryRow<Value, Value, BasesEntry>[],
		allEntries: readonly BasesEntry[],
		headers: readonly string[],
		autoWidths: readonly number[] | null = null,
	): void {
		const rowHeight = 30;
		this.customSummaryNames = new Set(Object.keys(customSummaries));
		const sizes = { ...columnSize, ...this.sizeOverride };
		const keys = [groupByProperty ?? GROUP_SIZE_KEY, ...columns.map((column) => column.id)];
		const allExplicitlySized = keys.every((key) => typeof sizes[key] === 'number' && sizes[key] > 0);
		const widths = this.getColumnWidths(groupByProperty, columns, sizes, autoWidths);
		const starts = widths.map((_, index) => widths.slice(0, index).reduce((total, width) => total + width, 0));
		const totalWidth = widths.reduce((total, width) => total + width, 0);

		const head = this.rootEl.createDiv('bases-thead');
		head.setCssProps({ '--sbv-width': `${totalWidth}px` });
		const headerRow = head.createDiv('bases-tr');
		headerRow.dataset.ignoreSwipe = 'true';
		for (let index = 0; index < headers.length; index += 1) {
			this.renderHeaderCell(
				headerRow,
				headers[index],
				index === 0 ? null : columns[index - 1],
				widths[index],
				starts[index],
				groupByProperty,
				groupDirection,
				customSummaries,
				columns,
			);
		}

		const tableContainer = this.rootEl.createDiv('bases-table-container');
		tableContainer.setCssProps({ '--sbv-width': `${totalWidth}px`, '--sbv-height': `${rows.length * rowHeight}px` });
		const table = tableContainer.createDiv('bases-table');
		table.setCssProps({ '--sbv-width': `${totalWidth}px`, '--sbv-height': `${rows.length * rowHeight}px` });
		const body = table.createDiv('bases-tbody');
		body.setCssProps({
			'--sbv-height': `${rows.length * rowHeight}px`,
			'--bases-table-row-height': `${rowHeight}px`,
		});

		for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
			const row = rows[rowIndex];
			const tableRow = body.createDiv('bases-tr summary-base-view-row');
			tableRow.setCssProps({ '--sbv-top': `${rowIndex * rowHeight}px`, '--sbv-width': `${totalWidth}px` });
			const rowEntries = row.entries ?? [];
			if (rowEntries.length > 0) {
				tableRow.tabIndex = 0;
				tableRow.setAttribute('role', 'button');
				const groupLabel = row.key instanceof NullValue ? '(Empty)' : row.key.toString();
				tableRow.setAttribute('aria-label', `Open notes in ${groupLabel} (${row.count})`);
				tableRow.addEventListener('click', (event) => {
					if (event.target instanceof Element && event.target.closest('a')) {
						return;
					}
					this.openGroupEntriesMenu(event, groupLabel, rowEntries);
				});
				tableRow.addEventListener('keydown', (event) => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						this.openGroupEntriesMenu(event, groupLabel, rowEntries);
					}
				});
			}
			const values: Array<Value | string | null> = [
				row.key,
				...columns.map((column, index) => column.propertyId === null ? String(row.count) : row.values[index]),
			];
			for (let columnIndex = 0; columnIndex < values.length; columnIndex += 1) {
				const cell = tableRow.createDiv('bases-td');
				const propertyId = columnIndex === 0 ? groupByProperty : columns[columnIndex - 1].propertyId;
				if (propertyId) {
					cell.dataset.property = propertyId;
				}
				cell.setCssProps({ '--sbv-start': `${starts[columnIndex]}px`, '--sbv-width': `${widths[columnIndex]}px` });
				const value = values[columnIndex];
				const isNumeric = value instanceof NumberValue
					|| (columnIndex > 0 && columns[columnIndex - 1].propertyId === null);
				const content = cell.createDiv('bases-table-cell bases-rendered-value');
				content.toggleClass('summary-base-view-numeric', isNumeric);
				if (typeof value === 'string') {
					content.setText(value);
					content.setAttribute('title', value);
				} else if (columnIndex === 0 && value instanceof NullValue) {
					content.addClass('summary-base-view-no-summary');
					content.setText('(Empty)');
					content.setAttribute('title', '(Empty)');
				} else if (value && !(value instanceof NullValue)) {
					renderValue(content, value, this.renderContext);
					const text = value.toString();
					if (text) {
						content.setAttribute('title', text);
					}
				} else if (columnIndex > 0 && columns[columnIndex - 1].propertyId !== null && !columns[columnIndex - 1].summaryKey) {
					content.addClass('summary-base-view-no-summary');
					content.setText('–');
				}
			}
		}

		const footer = this.rootEl.createDiv('bases-tr bases-table-footer');
		footer.setCssProps({ '--sbv-width': `${totalWidth}px` });
		const groupFooter = this.createFooterCell(footer, widths[0], starts[0]).createDiv('bases-table-summary-cell');
		if (columns.some((column) => column.propertyId === null)) {
			groupFooter.createDiv('summary-content').createSpan({ cls: 'placeholder', text: '' });
		} else {
			groupFooter.tabIndex = 0;
			groupFooter.setAttribute('role', 'button');
			groupFooter.setAttribute('aria-label', 'Add count column');
			const addButton = groupFooter.createDiv('summary-content').createSpan('summary-base-view-add-count');
			setIcon(addButton.createSpan('summary-base-view-add-count-icon'), 'plus');
			addButton.createSpan({ text: 'Add count' });
			const addCount = (): void => this.saveColumns([{ id: COUNT_COLUMN_ID, propertyId: null }, ...columns]);
			groupFooter.addEventListener('click', addCount);
			groupFooter.addEventListener('keydown', (event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					addCount();
				}
			});
		}

		for (let index = 0; index < columns.length; index += 1) {
			const column = columns[index];
			const cell = this.createFooterCell(footer, widths[index + 1], starts[index + 1]);
			const summaryCell = cell.createDiv('bases-table-summary-cell');
			const content = summaryCell.createDiv('summary-content');
			if (column.propertyId === null) {
				const countKey = column.summaryKey ?? 'Count';
				summaryCell.tabIndex = 0;
				summaryCell.setAttribute('role', 'button');
				summaryCell.setAttribute('aria-label', 'Choose summary for Count');
				setIcon(summaryCell.createDiv('summary-expand-button'), 'chevrons-up-down');
				const countValue = summarizeCounts(rows.map((row) => row.count), countKey);
				if (countKey === COUNT_SUMMARY_NONE || countValue === null) {
					content.createSpan({ cls: 'placeholder summary-base-view-add-summary', text: 'Add summary' });
				} else {
					content.createDiv({ cls: 'summary-function-name', text: countKey });
					content.createDiv({ cls: 'summary-function-value', text: String(countValue) });
				}
				summaryCell.addEventListener('click', (event) => this.openCountSummaryMenu(event, column));
				summaryCell.addEventListener('keydown', (event) => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						summaryCell.click();
					}
				});
				continue;
			}
			summaryCell.tabIndex = 0;
			summaryCell.setAttribute('role', 'button');
			summaryCell.setAttribute('aria-label', `Choose summary for ${headers[index + 1]}`);
			setIcon(summaryCell.createDiv('summary-expand-button'), 'chevrons-up-down');
			if (column.summaryKey) {
				content.createDiv({ cls: 'summary-function-name', text: column.summaryKey });
				const value = this.getSummaryValue([...allEntries], column.propertyId as BasesPropertyId, column.summaryKey);
				renderValue(content.createDiv('summary-function-value'), value, this.renderContext);
			} else {
				content.createSpan({ cls: 'placeholder summary-base-view-add-summary', text: 'Add summary' });
			}
			summaryCell.addEventListener('click', (event) => this.openSummaryMenu(event, column, customSummaries));
			summaryCell.addEventListener('keydown', (event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					summaryCell.click();
				}
			});
		}

		if (this.config.get(SHOW_SUMMARY_ROW_KEY) === false) {
			footer.remove();
		}

		if (autoWidths === null && !allExplicitlySized) {
			const measured = this.measureColumnWidths(widths.length);
			this.rootEl.empty();
			this.renderTable(
				groupByProperty,
				groupDirection,
				columns,
				customSummaries,
				columnSize,
				rows,
				allEntries,
				headers,
				measured,
			);
			return;
		}

		this.tableLayout = {
			groupByProperty,
			columns,
			head,
			tableContainer,
			table,
			body,
			footer,
			widths: [...widths],
		};
	}

	private openGroupEntriesMenu(event: MouseEvent | KeyboardEvent, groupLabel: string, entries: readonly BasesEntry[]): void {
		const menu = new Menu();
		menu.setParentElement(this.rootEl);
		menu.addItem((item) => item
			.setTitle(`${groupLabel} (${entries.length})`)
			.setIsLabel(true));
		menu.addSeparator();
		const sorted = [...entries].sort((a, b) => a.file.basename.localeCompare(b.file.basename));
		const limit = 30;
		for (const entry of sorted.slice(0, limit)) {
			const folder = entry.file.parent?.path;
			const title = folder && folder !== '/' ? `${entry.file.basename} — ${folder}` : entry.file.basename;
			menu.addItem((item) => item
				.setTitle(title)
				.setIcon('file-text')
				.onClick(() => {
					void this.app.workspace.getLeaf(false).openFile(entry.file);
				}));
		}
		if (sorted.length > limit) {
			menu.addItem((item) => item
				.setTitle(`...and ${sorted.length - limit} more`)
				.setIsLabel(true));
		}
		if (event instanceof MouseEvent) {
			menu.showAtMouseEvent(event);
		} else if (event.currentTarget instanceof HTMLElement) {
			const rect = event.currentTarget.getBoundingClientRect();
			menu.showAtPosition({ x: rect.left + 12, y: rect.bottom });
		}
	}

	private getColumnLabel(column: SummaryColumn, columns: readonly SummaryColumn[]): string {
		if (column.propertyId === null) {
			return 'Count';
		}
		const name = this.config.getDisplayName(column.propertyId as BasesPropertyId);
		const shared = columns.filter((item) => item.propertyId === column.propertyId).length > 1;
		return shared && column.summaryKey ? `${name} (${column.summaryKey})` : name;
	}

	private renderHeaderCell(
		row: HTMLElement,
		label: string,
		column: SummaryColumn | null,
		width: number,
		start: number,
		groupByProperty: BasesPropertyId | null,
		groupDirection: 'ASC' | 'DESC',
		customSummaries: Readonly<Record<string, string>>,
		columns: readonly SummaryColumn[],
	): void {
		const propertyId = column ? column.propertyId : groupByProperty;
		const cell = row.createDiv(`bases-td${column?.propertyId === null ? '' : ' mod-implicit'}`);
		if (propertyId) {
			cell.dataset.property = propertyId;
		}
		cell.dataset.ignoreSwipe = 'true';
		cell.tabIndex = 0;
		cell.setAttribute('role', 'button');
		cell.setAttribute('aria-label', `Sort by ${label}`);
		cell.setCssProps({ '--sbv-start': `${start}px`, '--sbv-width': `${width}px` });
		const header = cell.createDiv('bases-table-header');
		const labelEl = header.createDiv('bases-table-header-label');
		setIcon(labelEl.createDiv('bases-table-header-icon'), propertyId ? this.getPropertyIcon(propertyId) : 'binary');
		const nameEl = labelEl.createDiv({ cls: 'bases-table-header-name', text: label });
		nameEl.setAttribute('title', label);
		const sortIndicator = cell.createDiv('bases-table-header-sort');
		const sort = this.getHeaderSort(column, groupDirection);
		if (sort) {
			setIcon(sortIndicator, sort.direction === 'ASC' ? 'chevron-up' : 'chevron-down');
			cell.dataset.sort = sort.direction;
			cell.setAttribute('aria-sort', sort.direction === 'ASC' ? 'ascending' : 'descending');
		}
		const resizer = cell.createDiv('bases-table-header-resizer');
		const sizeKey = column ? column.id : groupByProperty ?? GROUP_SIZE_KEY;
		const columnIndex = column ? columns.findIndex((item) => item.id === column.id) + 1 : 0;
		resizer.addEventListener('click', (event) => event.stopPropagation());
		resizer.addEventListener('pointerdown', (event) => this.startResize(event, sizeKey, columnIndex));
		resizer.addEventListener('dblclick', (event) => {
			event.stopPropagation();
			this.autoFitColumn(sizeKey, columnIndex);
		});
		cell.addEventListener('click', () => this.toggleSort(column, groupByProperty, groupDirection));
		cell.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				this.toggleSort(column, groupByProperty, groupDirection);
			}
		});
		cell.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			this.openColumnMenu(event, column, groupByProperty, groupDirection, customSummaries, columns);
		});
	}

	private applyColumnWidths(widths: readonly number[]): void {
		const layout = this.tableLayout;
		if (!layout) {
			return;
		}
		layout.widths = [...widths];
		const starts = widths.map((_, index) => widths.slice(0, index).reduce((total, width) => total + width, 0));
		const totalWidth = widths.reduce((total, width) => total + width, 0);
		layout.head.setCssProps({ '--sbv-width': `${totalWidth}px` });
		layout.tableContainer.setCssProps({ '--sbv-width': `${totalWidth}px` });
		layout.table.setCssProps({ '--sbv-width': `${totalWidth}px` });
		layout.footer.setCssProps({ '--sbv-width': `${totalWidth}px` });

		const updateRow = (row: Element): void => {
			Array.from(row.children).forEach((cell, index) => {
				if (cell.instanceOf(HTMLElement) && index < widths.length) {
					cell.setCssProps({ '--sbv-start': `${starts[index]}px`, '--sbv-width': `${widths[index]}px` });
				}
			});
		};

		const headerRow = layout.head.firstElementChild;
		if (headerRow) {
			updateRow(headerRow);
		}
		for (const row of Array.from(layout.body.children)) {
			if (row.instanceOf(HTMLElement)) {
				row.setCssProps({ '--sbv-width': `${totalWidth}px` });
				updateRow(row);
			}
		}
		updateRow(layout.footer);
	}

	private autoFitColumn(sizeKey: string, columnIndex: number): void {
		const layout = this.tableLayout;
		if (!layout) {
			return;
		}
		const measured = this.measureColumnWidths(layout.widths.length);
		const fitWidth = Math.max(MIN_COLUMN_WIDTH, Math.min(measured[columnIndex] ?? 160, MAX_AUTO_COLUMN_WIDTH));
		const nextWidths = [...layout.widths];
		nextWidths[columnIndex] = fitWidth;
		this.applyColumnWidths(nextWidths);
		const stored = readColumnSize(this.config.get('columnSize')) ?? {};
		this.config.set('columnSize', { ...stored, [sizeKey]: fitWidth });
	}

	private startResize(event: PointerEvent, sizeKey: string, columnIndex: number): void {
		event.preventDefault();
		event.stopPropagation();
		const startWidth = this.tableLayout?.widths[columnIndex] ?? 160;
		const startX = event.clientX;
		const direction = getComputedStyle(this.rootEl).direction === 'rtl' ? -1 : 1;
		let frame = 0;
		let latestWidth = startWidth;
		const applyWidth = (): void => {
			if (!this.tableLayout) {
				return;
			}
			const nextWidths = [...this.tableLayout.widths];
			nextWidths[columnIndex] = latestWidth;
			this.applyColumnWidths(nextWidths);
		};
		const onMove = (moveEvent: PointerEvent): void => {
			latestWidth = Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + (moveEvent.clientX - startX) * direction));
			this.sizeOverride = { ...this.sizeOverride, [sizeKey]: latestWidth };
			if (frame === 0) {
				frame = window.requestAnimationFrame(() => {
					frame = 0;
					applyWidth();
				});
			}
		};
		const cleanup = (): void => {
			if (frame !== 0) {
				window.cancelAnimationFrame(frame);
				frame = 0;
			}
			activeWindow.removeEventListener('pointermove', onMove);
			activeWindow.removeEventListener('pointerup', onUp);
			activeWindow.removeEventListener('pointercancel', onUp);
			activeWindow.removeEventListener('blur', onUp);
		};
		const onUp = (): void => {
			cleanup();
			applyWidth();
			const stored = readColumnSize(this.config.get('columnSize')) ?? {};
			const next = { ...stored, ...this.sizeOverride };
			this.sizeOverride = {};
			this.config.set('columnSize', next);
		};
		activeWindow.addEventListener('pointermove', onMove);
		activeWindow.addEventListener('pointerup', onUp);
		activeWindow.addEventListener('pointercancel', onUp);
		activeWindow.addEventListener('blur', onUp);
	}

	private getHeaderSort(
		column: SummaryColumn | null,
		groupDirection: 'ASC' | 'DESC',
	): { direction: 'ASC' | 'DESC' } | null {
		if (column === null) {
			return this.activeSort ? null : { direction: groupDirection };
		}
		return this.activeSort?.target === column.id ? { direction: this.activeSort.direction } : null;
	}

	private toggleSort(
		column: SummaryColumn | null,
		groupByProperty: BasesPropertyId | null,
		groupDirection: 'ASC' | 'DESC',
	): void {
		const current = this.getHeaderSort(column, groupDirection);
		this.setSort(column, current?.direction === 'ASC' ? 'DESC' : 'ASC', groupByProperty);
	}

	private setSort(
		column: SummaryColumn | null,
		direction: 'ASC' | 'DESC',
		groupByProperty: BasesPropertyId | null,
	): void {
		if (column === null) {
			this.activeSort = null;
			this.config.set(SUMMARY_SORT_KEY, null);
			// The group column is sorted through both native menus: Sort lists it and Group shows its direction.
			this.saveSort(groupByProperty ? [{ property: groupByProperty, direction }] : []);
			if (groupByProperty) {
				this.setGroupDirection(groupByProperty, direction);
			} else {
				this.onDataUpdated();
			}
			return;
		}
		this.activeSort = { target: column.id, direction };
		const isNativeSingleSort = Boolean(column.propertyId && column.id === column.propertyId);
		this.config.set(SUMMARY_SORT_KEY, isNativeSingleSort ? null : this.activeSort);
		this.saveSort(isNativeSingleSort
			? [{ property: column.propertyId as BasesPropertyId, direction }]
			: []);
		this.onDataUpdated();
	}

	private saveSort(sorts: SummarySortSetting[]): void {
		this.currentSorts = sorts;
		this.pendingSortSignature = JSON.stringify(sorts);
		writeNativeSort(this.config, sorts);
	}

	private setGroupDirection(propertyId: BasesPropertyId, direction: 'ASC' | 'DESC'): void {
		writeNativeGroupBy(this.config, { property: propertyId, direction });
		this.onDataUpdated();
	}

	private openColumnMenu(
		event: MouseEvent,
		column: SummaryColumn | null,
		groupByProperty: BasesPropertyId | null,
		groupDirection: 'ASC' | 'DESC',
		customSummaries: Readonly<Record<string, string>>,
		columns: readonly SummaryColumn[],
	): void {
		const activeSort = this.getHeaderSort(column, groupDirection);
		const menu = new Menu();
		menu.setParentElement(this.rootEl);
		menu.addItem((item) => item
			.setTitle('Sort ascending')
			.setIcon('chevron-up')
			.setChecked(activeSort?.direction === 'ASC')
			.onClick(() => this.setSort(column, 'ASC', groupByProperty)));
		menu.addItem((item) => item
			.setTitle('Sort descending')
			.setIcon('chevron-down')
			.setChecked(activeSort?.direction === 'DESC')
			.onClick(() => this.setSort(column, 'DESC', groupByProperty)));
		if (column && activeSort) {
			menu.addItem((item) => item
				.setTitle('Remove sort')
				.onClick(() => this.removeSort()));
		}

		if (column && column.propertyId === null) {
			menu.addSeparator();
			menu.addItem((item) => item
				.setTitle('Choose summary')
				.setIcon('sigma')
				.onClick(() => this.openCountSummaryMenu(event, column)));
		}
		if (column?.propertyId) {
			menu.addSeparator();
			menu.addItem((item) => item
				.setTitle(column.summaryKey ? 'Edit summary' : 'Choose summary')
				.setIcon(column.summaryKey ? 'pencil' : 'sigma')
				.onClick(() => column.summaryKey
					? this.editSummary(column, column.summaryKey, customSummaries)
					: this.openSummaryMenu(event, column, customSummaries)));
			menu.addItem((item) => item
				.setTitle('Add summary column')
				.setIcon('columns-3')
				.onClick(() => this.addSummaryColumn(column)));
		}
		if (column && !columns.some((item) => item.propertyId === null)) {
			menu.addItem((item) => item
				.setTitle('Add count column')
				.setIcon('hash')
				.onClick(() => this.saveColumns([{ id: COUNT_COLUMN_ID, propertyId: null }, ...columns])));
		}
		if (column) {
			menu.addItem((item) => item
				.setTitle('Remove column')
				.setIcon('eye-off')
				.onClick(() => this.removeColumn(column)));
		} else {
			menu.addSeparator();
			if (groupByProperty) {
				menu.addItem((item) => item
					.setTitle('Add summary column')
					.setIcon('columns-3')
					.onClick(() => this.saveColumns([...columns, { id: `${groupByProperty}~new`, propertyId: groupByProperty }])));
			}
		}
		if (!column && !columns.some((item) => item.propertyId === null)) {
			menu.addItem((item) => item
				.setTitle('Add count column')
				.setIcon('hash')
				.onClick(() => this.saveColumns([{ id: COUNT_COLUMN_ID, propertyId: null }, ...columns])));
		}
		menu.showAtMouseEvent(event);
	}

	private removeSort(): void {
		this.activeSort = null;
		this.config.set(SUMMARY_SORT_KEY, null);
		this.saveSort([]);
		this.onDataUpdated();
	}

	private saveColumns(next: readonly SummaryColumn[]): void {
		const config = JSON.parse(JSON.stringify(summaryColumnsToConfig(next))) as SummaryColumnConfig[];
		this.columnOverride = config;
		this.config.set('summaryColumns', config);
		this.onDataUpdated();
	}

	private addSummaryColumn(column: SummaryColumn): void {
		const index = this.currentColumns.findIndex((item) => item.id === column.id);
		const next = [...this.currentColumns];
		next.splice(index + 1, 0, { id: `${column.id}~new`, propertyId: column.propertyId });
		this.saveColumns(next);
	}

	private removeColumn(column: SummaryColumn): void {
		const next = this.currentColumns.filter((item) => item.id !== column.id);
		if (column.propertyId && !next.some((item) => item.propertyId === column.propertyId)
			&& column.propertyId !== this.currentGroupBy) {
			writeNativeOrder(this.config, this.config.getOrder().filter((property) => property !== column.propertyId));
		}
		this.saveColumns(next);
	}

	private getExampleValue(propertyId: string): Value | null {
		return this.data.data
			.filter((entry) => !this.isExcluded(entry))
			.map((entry) => entry.getValue(propertyId as BasesPropertyId))
			.find((value): value is Value => value !== null && !(value instanceof NullValue)) ?? null;
	}

	private getPropertyIcon(propertyId: string): string {
		if (propertyId.startsWith('formula.')) {
			return 'function-square';
		}
		if (propertyId.startsWith('file.')) {
			return 'info';
		}

		const value = this.getExampleValue(propertyId);
		if (value instanceof NumberValue) {
			return 'binary';
		}
		if (value instanceof DateValue) {
			return 'calendar';
		}
		if (isDurationValue(value)) {
			return 'clock';
		}
		if (value instanceof BooleanValue) {
			return 'check';
		}
		if (value instanceof ListValue) {
			return 'list';
		}
		if (value instanceof LinkValue) {
			return 'link';
		}
		return value instanceof StringValue ? 'text' : 'info';
	}

	private createFooterCell(row: HTMLElement, width: number, start: number): HTMLElement {
		const cell = row.createDiv('bases-td');
		cell.setCssProps({ '--sbv-start': `${start}px`, '--sbv-width': `${width}px` });
		return cell;
	}

	private measureColumnWidths(count: number): number[] {
		const widest = new Array<number>(count).fill(0);
		const measure = (el: Element | null, extra: number, index: number): void => {
			if (!el) {
				return;
			}
			const range = activeDocument.createRange();
			range.selectNodeContents(el);
			widest[index] = Math.max(widest[index], Math.ceil(range.getBoundingClientRect().width) + extra);
		};
		const rowSelectors: Array<[string, string, number]> = [
			['.bases-thead .bases-tr', '.bases-table-header-label', 44],
			['.bases-tbody .bases-tr', '.bases-table-cell', 24],
		];
		for (const [rowSelector, contentSelector, extra] of rowSelectors) {
			for (const row of Array.from(this.rootEl.querySelectorAll(rowSelector))) {
				Array.from(row.children).forEach((cell, index) => measure(cell.querySelector(contentSelector), extra, index));
			}
		}
		const footer = this.rootEl.querySelector('.bases-table-footer');
		Array.from(footer?.children ?? []).forEach((cell, index) => {
			const content = cell.querySelector('.summary-content');
			measure(content, cell.querySelector('.summary-expand-button') ? 44 : 24, index);
		});
		return widest;
	}

	private getColumnWidths(
		groupByProperty: string | null,
		columns: readonly SummaryColumn[],
		columnSize: Readonly<Record<string, number>>,
		autoWidths: readonly number[] | null,
	): number[] {
		const keys = [groupByProperty ?? GROUP_SIZE_KEY, ...columns.map((column) => column.id)];
		return keys.map((key, index) => {
			const fallback = autoWidths?.[index] ?? (index === 0 ? 180 : 160);
			return Math.max(MIN_COLUMN_WIDTH, columnSize[key] ?? Math.min(fallback, MAX_AUTO_COLUMN_WIDTH));
		});
	}

	private openSummaryMenu(
		event: MouseEvent,
		column: SummaryColumn,
		customSummaries: Readonly<Record<string, string>>,
	): void {
		const propertyId = column.propertyId;
		if (propertyId === null) {
			return;
		}
		const selectedSummary = column.summaryKey;
		const entries = this.data.data.filter((entry) => !this.isExcluded(entry));
		const exampleValue = this.getExampleValue(propertyId);
		const options = summaryOptions(exampleValue, customSummaries);
		const menu = new Menu();
		menu.setParentElement(this.rootEl);
		for (const summaryKey of options) {
			menu.addItem((item) => item
				.setTitle(summaryKey)
				.setIcon(this.getPropertyIcon(propertyId))
				.setChecked(summaryKey === selectedSummary)
				.onClick(() => this.setSummary(column, summaryKey)));
		}
		menu.addSeparator();
		menu.addItem((item) => item
			.setTitle('Add summary')
			.setIcon('plus')
			.onClick(() => this.promptAddSummary(column, options)));
		if (selectedSummary) {
			menu.addItem((item) => item
				.setTitle('Edit summary')
				.setIcon('pencil')
				.onClick(() => this.editSummary(column, selectedSummary, customSummaries)));
			menu.addItem((item) => item
				.setTitle('Hide summary')
				.setIcon('trash-2')
				.onClick(() => this.setSummary(column, null)));
		}
		this.showFooterMenu(event, menu);

		const menuEl = (menu as unknown as { dom?: HTMLElement }).dom
			?? Array.from(activeDocument.querySelectorAll<HTMLElement>('.menu')).pop();
		const scroll = menuEl?.querySelector<HTMLElement>('.menu-scroll');
		if (!menuEl || !scroll) {
			return;
		}

		menuEl.classList.add('bases-toolbar-menu');
		const header = createDiv('bases-toolbar-menu-header');
		const back = header.createDiv('bases-toolbar-menu-header-back clickable-icon tappable mod-raised');
		back.addClass('summary-base-view-hidden');
		setIcon(back, 'arrow-left');
		header.createDiv({
			cls: 'bases-toolbar-menu-header-title',
			text: this.config.getDisplayName(propertyId as BasesPropertyId),
		});
		const headerEnd = header.createDiv('bases-toolbar-menu-header-end');
		headerEnd.createDiv('bases-toolbar-menu-header-actions');
		const closeButton = headerEnd.createDiv('clickable-icon tappable mod-raised');
		setIcon(closeButton, 'check');
		closeButton.setAttribute('aria-label', 'Close summary menu');
		closeButton.addEventListener('click', () => menu.hide());
		menuEl.insertBefore(header, scroll);

		const container = createDiv('bases-toolbar-menu-container');
		const searchContainer = container.createDiv('search-input-container');
		const search = searchContainer.createEl('input', {
			type: 'search',
			placeholder: 'Find or create...',
			cls: 'node-insert-event',
		});
		search.setAttribute('spellcheck', 'false');
		search.setAttribute('enterkeyhint', 'search');
		searchContainer.createDiv('search-input-clear-button').addEventListener('click', () => {
			search.value = '';
			search.dispatchEvent(new Event('input'));
			search.focus();
		});

		const toolbarItems = container.createDiv('bases-toolbar-items');
		const formulaGroup = toolbarItems.createDiv('suggestion-group');
		formulaGroup.dataset.group = 'formulas';
		const actionGroup = toolbarItems.createDiv('suggestion-group');
		actionGroup.dataset.group = 'actions';
		const createMatchItem = toolbarItems.createDiv('menu-item suggestion-item bases-toolbar-menu-item summary-base-view-create-match summary-base-view-hidden');
		const createMatchInfo = createMatchItem.createDiv('bases-toolbar-menu-item-info');
		setIcon(createMatchInfo.createDiv('bases-toolbar-menu-item-info-icon'), 'plus');
		const createMatchTitle = createMatchInfo.createDiv('bases-toolbar-menu-item-name menu-item-title');
		createMatchItem.addEventListener('click', () => {
			const name = search.value.trim();
			menu.hide();
			this.promptAddSummary(column, options, name);
		});

		for (const item of Array.from(scroll.querySelectorAll<HTMLElement>('.menu-item'))) {
			const title = item.querySelector<HTMLElement>('.menu-item-title')?.textContent?.trim() ?? '';
			const isHideAction = title === 'Hide summary';
			const isAddAction = title === 'Add summary';
			const isEditAction = title === 'Edit summary';
			const isAction = isHideAction || isAddAction || isEditAction;
			const key = isAction ? null : title;
			const info = createDiv('bases-toolbar-menu-item-info');
			const icon = info.createDiv('bases-toolbar-menu-item-info-icon');
			setIcon(icon, isHideAction ? 'trash-2' : isAddAction ? 'plus' : isEditAction ? 'pencil' : key === selectedSummary ? 'check' : this.getPropertyIcon(propertyId));
			const name = info.createDiv('bases-toolbar-menu-item-name menu-item-title');
			name.setText(title);
			if (key) {
				const value = this.getSummaryValue([...entries], propertyId as BasesPropertyId, key);
				const text = value && !(value instanceof NullValue) ? value.toString() : '';
				info.createDiv({ cls: 'bases-toolbar-menu-item-value', text });
			}
			const arrow = item.createDiv('clickable-icon bases-toolbar-menu-item-icon');
			if (!isAction) {
				setIcon(arrow, 'chevron-right');
			}
			item.toggleClass('is-selected', key !== null && key === selectedSummary);
			if (key) {
				arrow.setAttribute('aria-label', 'Edit formula');
				arrow.addEventListener('click', (clickEvent) => {
					clickEvent.stopPropagation();
					menu.hide();
					this.promptEditSummary(column, key, customSummaries[key] ?? builtinSummaryFormula(key, exampleValue));
				});
			}
			item.classList.add('suggestion-item', 'bases-toolbar-menu-item', 'bases-summary-menu-item');
			item.replaceChildren(info, arrow);
			(isAction ? actionGroup : formulaGroup).appendChild(item);
		}
		scroll.replaceChildren(container);
		const updateFilter = (): void => {
			const rawQuery = search.value.trim();
			const query = rawQuery.toLocaleLowerCase();
			let visibleFormulas = 0;
			for (const item of Array.from(formulaGroup.querySelectorAll<HTMLElement>('.bases-summary-menu-item'))) {
				const matches = (item.querySelector('.bases-toolbar-menu-item-name')?.textContent ?? '')
					.toLocaleLowerCase()
					.includes(query);
				item.toggleClass('summary-base-view-hidden', !matches);
				if (matches) {
					visibleFormulas += 1;
				}
			}
			formulaGroup.toggleClass('summary-base-view-hidden', visibleFormulas === 0);
			let visibleActions = 0;
			for (const item of Array.from(actionGroup.querySelectorAll<HTMLElement>('.bases-summary-menu-item'))) {
				const matches = (item.querySelector('.bases-toolbar-menu-item-name')?.textContent ?? '')
					.toLocaleLowerCase()
					.includes(query);
				item.toggleClass('summary-base-view-hidden', !matches);
				if (matches) {
					visibleActions += 1;
				}
			}
			const showCreate = rawQuery.length > 0 && visibleFormulas === 0;
			createMatchItem.toggleClass('summary-base-view-hidden', !showCreate);
			if (showCreate) {
				createMatchTitle.setText(`Create "${rawQuery}"`);
			}
			actionGroup.toggleClass('summary-base-view-hidden', visibleActions === 0);
		};
		search.addEventListener('input', updateFilter);
		search.addEventListener('keydown', (keyEvent) => {
			if (keyEvent.key === 'Enter' && !keyEvent.isComposing) {
				keyEvent.preventDefault();
				const firstMatch = formulaGroup.querySelector<HTMLElement>('.bases-summary-menu-item:not(.summary-base-view-hidden)');
				if (firstMatch) {
					firstMatch.click();
				} else if (search.value.trim().length > 0) {
					createMatchItem.click();
				}
			}
		});
		window.setTimeout(() => search.focus(), 0);
	}

	// Anchors a footer menu to its cell so it opens beneath the summary instead of covering it.
	private showFooterMenu(event: MouseEvent, menu: Menu): void {
		const cell = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
		if (!cell?.hasClass('bases-table-summary-cell')) {
			menu.showAtMouseEvent(event);
			return;
		}
		cell.addClass('has-active-menu');
		menu.onHide(() => cell.removeClass('has-active-menu'));
		const rect = cell.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 2 });
	}

	private openCountSummaryMenu(event: MouseEvent, column: SummaryColumn): void {
		const selected = column.summaryKey ?? 'Count';
		const menu = new Menu();
		menu.setParentElement(this.rootEl);
		for (const summaryKey of COUNT_SUMMARIES) {
			menu.addItem((item) => item
				.setTitle(summaryKey)
				.setIcon('hash')
				.setChecked(summaryKey === selected)
				.onClick(() => this.setSummary(column, summaryKey)));
		}
		menu.addSeparator();
		menu.addItem((item) => item
			.setTitle('Hide summary')
			.setIcon('trash-2')
			.onClick(() => this.setSummary(column, COUNT_SUMMARY_NONE)));
		this.showFooterMenu(event, menu);
	}

	private editSummary(
		column: SummaryColumn,
		summaryKey: string,
		customSummaries: Readonly<Record<string, string>>,
	): void {
		const exampleValue = column.propertyId === null ? null : this.getExampleValue(column.propertyId);
		this.promptEditSummary(column, summaryKey, customSummaries[summaryKey] ?? builtinSummaryFormula(summaryKey, exampleValue));
	}

	private promptAddSummary(column: SummaryColumn, existingNames: readonly string[], initialName?: string): void {
		this.openSummaryModal(column, { existingNames: new Set(existingNames), initialName });
	}

	private promptEditSummary(column: SummaryColumn, name: string, formula: string): void {
		const exampleValue = column.propertyId === null ? null : this.getExampleValue(column.propertyId);
		const isCustom = this.customSummaryNames.has(name);
		this.openSummaryModal(column, {
			existingNames: new Set(),
			edit: { name, formula },
			choices: summaryOptions(exampleValue, Object.fromEntries([...this.customSummaryNames].map((item) => [item, '']))),
			onChoose: (choice) => this.setSummary(column, choice),
			onDelete: isCustom ? (targetName) => this.deleteCustomSummary(targetName) : undefined,
		});
	}

	private deleteCustomSummary(name: string): void {
		const baseFile = this.getBaseFile();
		if (!baseFile) {
			new Notice('Summary settings can only be saved when the Base file is available.');
			return;
		}
		void this.app.vault.process(baseFile, (source) => deleteCustomSummaryDefinition(source, name))
			.then(() => {
				const updated = this.currentColumns.map((item) =>
					item.summaryKey === name ? { ...item, summaryKey: undefined } : item,
				);
				this.saveColumns(updated);
			})
			.catch((error: unknown) => {
				console.error('Simple Summary Base View: failed to delete summary', error);
				new Notice('Could not delete the summary from this Base.');
			});
	}

	private openSummaryModal(
		column: SummaryColumn,
		options: Pick<SummaryModalOptions, 'existingNames' | 'initialName' | 'edit' | 'choices' | 'onChoose' | 'onDelete'>,
	): void {
		new AddSummaryModal(this.app, {
			...options,
			onSubmit: (name, formula) => {
				const baseFile = this.getBaseFile();
				if (!baseFile) {
					new Notice('Summary settings can only be saved when the Base file is available.');
					return;
				}
				void this.app.vault.process(baseFile, (source) => upsertCustomSummaryDefinition(source, name, formula))
					.then(() => this.applySummaryAfterReload(column.id, name))
					.catch((error: unknown) => {
						console.error('Simple Summary Base View: failed to save summary', error);
						new Notice('Could not save the summary to this Base.');
					});
			},
		}).open();
	}

	// Bases reloads the file after the write and would discard a config change made before then.
	private applySummaryAfterReload(columnId: string, summaryKey: string): void {
		const apply = (): void => {
			if (this.pendingSummary?.apply !== apply) {
				return;
			}
			window.clearTimeout(this.pendingSummary?.timer);
			this.pendingSummary = null;
			const column = this.currentColumns.find((item) => item.id === columnId);
			if (column) {
				this.setSummary(column, summaryKey);
			}
		};
		window.clearTimeout(this.pendingSummary?.timer);
		this.pendingSummary = { apply, timer: window.setTimeout(apply, 2000) };
	}

	private setSummary(column: SummaryColumn, summaryKey: string | null): void {
		this.saveColumns(this.currentColumns.map((item) =>
			item.id === column.id ? { ...item, summaryKey: summaryKey ?? undefined } : item,
		));
	}

	private updateNativeToolbar(groupCount: number): void {
		const leafContent = this.rootEl.closest('.workspace-leaf-content');
		const toolbar = leafContent?.querySelector<HTMLElement>('.bases-toolbar') ?? null;
		if (!toolbar) {
			return;
		}

		if (toolbar !== this.toolbarEl) {
			this.detachToolbar();
			this.toolbarEl = toolbar;
			this.resultCountEl = toolbar.querySelector<HTMLElement>('.bases-toolbar-result-count');
			this.resultCountEl?.classList.add('summary-base-view-hide-result-count');
			this.sortBadgeEl = toolbar.querySelector<HTMLElement>('.bases-toolbar-sort-menu .toolbar-badge');
			this.originalSortBadgeText = this.sortBadgeEl?.textContent ?? '';
			this.originalSortBadgeDisplay = this.sortBadgeEl?.style.display ?? '';
			const before = toolbar.querySelector('.bases-toolbar-display-menu');
			const groupItem = toolbar.createDiv('bases-toolbar-item summary-base-view-group-count');
			const groupButton = groupItem.createDiv('text-icon-button tappable');
			groupButton.setAttribute('tabindex', '0');
			groupButton.setAttribute('role', 'button');
			groupButton.setAttribute('aria-label', 'Copy or export summary');
			this.groupCountLabelEl = groupButton.createSpan('text-button-label');
			groupButton.addEventListener('click', (event) => this.openResultsMenu(event));
			groupButton.addEventListener('keydown', (event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					groupButton.click();
				}
			});
			toolbar.insertBefore(groupItem, before);
		}

		if (this.groupCountLabelEl) {
			this.groupCountLabelEl.setText(`${groupCount} ${groupCount === 1 ? 'group' : 'groups'}`);
		}
		if (this.sortBadgeEl) {
			this.sortBadgeEl.setText(String(this.currentSorts.length));
			if (this.currentSorts.length > 0) {
				this.sortBadgeEl.style.removeProperty('display');
			}
			this.sortBadgeEl.toggleClass('summary-base-view-hidden', this.currentSorts.length === 0);
		}
	}

	private detachToolbar(): void {
		this.resultCountEl?.classList.remove('summary-base-view-hide-result-count');
		if (this.sortBadgeEl) {
			this.sortBadgeEl.setText(this.originalSortBadgeText);
			this.sortBadgeEl.removeClass('summary-base-view-hidden');
			this.sortBadgeEl.style.display = this.originalSortBadgeDisplay;
		}
		this.toolbarEl?.querySelector('.summary-base-view-group-count')?.remove();
		this.toolbarEl = null;
		this.resultCountEl = null;
		this.groupCountLabelEl = null;
		this.sortBadgeEl = null;
	}

	private openResultsMenu(event: MouseEvent): void {
		const menu = new Menu();
		const copy = (title: string, text: string): void => {
			menu.addItem((item) => item
				.setTitle(title)
				.setIcon('copy')
				.onClick(() => {
					void copyText(text).then(
						(copied) => new Notice(copied ? 'Summary copied to clipboard.' : 'Could not copy the summary.'),
					);
				}));
		};
		copy('Copy as CSV', this.currentCsv.replace(/\r\n/g, '\n'));
		copy('Copy as Markdown table', this.currentMarkdown);
		menu.addItem((item) => item
			.setTitle('Export CSV...')
			.setIcon('download')
			.onClick(() => this.downloadCsv()));
		menu.showAtMouseEvent(event);
	}

	private downloadCsv(): void {
		const blob = new Blob([this.currentCsv], { type: 'text/csv;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const link = createEl('a');
		link.href = url;
		link.download = `${(this.config.name || 'summary').replace(/[\\/:*?"<>|]+/g, '-')}.csv`;
		activeDocument.body.appendChild(link);
		link.click();
		link.remove();
		window.setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
}
