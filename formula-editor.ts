import {
	autocompletion,
	completionKeymap,
	type Completion,
	type CompletionContext,
	type CompletionResult,
} from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExtension, tooltips } from '@codemirror/view';

interface FormulaItem {
	label: string;
	detail?: string;
	info?: string;
	apply?: string;
}

export const PRESET_SUMMARIES: readonly FormulaItem[] = [
	{ label: 'Date range', apply: 'values.earliest().format("YYYY-MM-DD") + " ~ " + values.latest().format("YYYY-MM-DD")' },
	{ label: 'Average', apply: 'values.mean().round(2)' },
	{ label: 'Sum', apply: 'values.sum().round(2)' },
	{ label: 'Min', apply: 'values.min()' },
	{ label: 'Max', apply: 'values.max()' },
	{ label: 'Median', apply: 'values.median()' },
	{ label: 'Range', apply: 'values.max() - values.min()' },
	{ label: 'Earliest', apply: 'values.earliest()' },
	{ label: 'Latest', apply: 'values.latest()' },
	{ label: 'Checked', apply: 'values.filter(value == true).length' },
	{ label: 'Unchecked', apply: 'values.filter(value == false).length' },
	{ label: 'Unique', apply: 'values.unique().length' },
	{ label: 'Filled', apply: 'values.filter(!value.isType("null")).length' },
	{ label: 'Empty', apply: 'values.filter(value.isType("null")).length' },
];

const VALUES_MEMBERS: readonly FormulaItem[] = [
	{ label: 'sum()', detail: 'number', info: 'Sum of all numbers.' },
	{ label: 'mean()', detail: 'number', info: 'Average of all numbers.' },
	{ label: 'median()', detail: 'number', info: 'Median of all numbers.' },
	{ label: 'min()', detail: 'number | date', info: 'Smallest value.' },
	{ label: 'max()', detail: 'number | date', info: 'Largest value.' },
	{ label: 'stddev()', detail: 'number', info: 'Standard deviation.' },
	{ label: 'earliest()', detail: 'date', info: 'Earliest date.' },
	{ label: 'latest()', detail: 'date', info: 'Latest date.' },
	{ label: 'unique()', detail: 'list', info: 'Values with duplicates removed.' },
	{ label: 'filter()', detail: 'list', info: 'Keep values where the condition is true, using value.' },
	{ label: 'map()', detail: 'list', info: 'Transform each value, using value.' },
	{ label: 'reduce()', detail: 'any', info: 'Combine values using acc and value.' },
	{ label: 'sort()', detail: 'list', info: 'Sort the values.' },
	{ label: 'reverse()', detail: 'list', info: 'Reverse the order.' },
	{ label: 'flat()', detail: 'list', info: 'Flatten nested lists.' },
	{ label: 'slice()', detail: 'list', info: 'Take a range of values.' },
	{ label: 'join()', detail: 'string', info: 'Join the values into text.' },
	{ label: 'contains()', detail: 'boolean', info: 'True when the list contains a value.' },
	{ label: 'isEmpty()', detail: 'boolean', info: 'True when the list has no values.' },
	{ label: 'length', detail: 'number', info: 'Number of values.' },
];

const RESULT_MEMBERS: readonly FormulaItem[] = [
	{ label: 'round()', detail: 'number', info: 'Round to a number of decimal places.' },
	{ label: 'floor()', detail: 'number', info: 'Round down.' },
	{ label: 'ceil()', detail: 'number', info: 'Round up.' },
	{ label: 'abs()', detail: 'number', info: 'Absolute value.' },
	{ label: 'toFixed()', detail: 'string', info: 'Format with a fixed number of decimals.' },
	{ label: 'format()', detail: 'string', info: 'Format a date, for example "YYYY-MM-DD".' },
	{ label: 'date()', detail: 'date', info: 'Remove the time from a date.' },
	{ label: 'relative()', detail: 'string', info: 'Relative text such as "3 days ago".' },
	{ label: 'length', detail: 'number', info: 'Length of a list or text.' },
	{ label: 'isType()', detail: 'boolean', info: 'Check the type of a value.' },
];

const GLOBAL_ITEMS: readonly FormulaItem[] = [
	{ label: 'values', detail: 'list', info: 'Every value in this column for the group.' },
	{ label: 'value', detail: 'any', info: 'The current value inside filter(), map() and reduce().' },
	{ label: 'if()', detail: 'any', info: 'if(condition, trueResult, falseResult)' },
	{ label: 'number()', detail: 'number', info: 'Convert to a number.' },
	{ label: 'date()', detail: 'date', info: 'Parse a date.' },
	{ label: 'now()', detail: 'date', info: 'The current date and time.' },
	{ label: 'today()', detail: 'date', info: 'The current date.' },
	{ label: 'min()', detail: 'number', info: 'Smallest of the arguments.' },
	{ label: 'max()', detail: 'number', info: 'Largest of the arguments.' },
	{ label: 'list()', detail: 'list', info: 'Wrap a value in a list.' },
	{ label: 'true', detail: 'boolean' },
	{ label: 'false', detail: 'boolean' },
	{ label: 'null', detail: 'null' },
];

export const PRESET_SUMMARY_FORMULAS: Readonly<Record<string, string>> = Object.fromEntries(
	PRESET_SUMMARIES.flatMap((item) => (item.apply ? [[item.label, item.apply]] : [])),
);

function toCompletion(item: FormulaItem, type: string, boost = 0): Completion {
	const completion: Completion = { label: item.label, type, boost };
	if (item.detail) {
		completion.detail = item.detail;
	}
	if (item.info) {
		const info = item.info;
		completion.info = () => {
			return createDiv({ text: info });
		};
	}
	if (item.apply) {
		completion.apply = item.apply;
		completion.detail = item.apply;
	} else if (item.label.endsWith('()')) {
		const text = item.label;
		completion.apply = (view, _completion, from, to) => {
			view.dispatch({
				changes: { from, to, insert: text },
				selection: { anchor: from + text.length - 1 },
			});
		};
	}
	return completion;
}

function toCompletions(items: readonly FormulaItem[], type: string): Completion[] {
	return items.map((item) => toCompletion(item, type));
}

export function formulaCompletions(context: CompletionContext): CompletionResult | null {
	const word = context.matchBefore(/[\w]*/);
	if (!word) {
		return null;
	}
	const before = context.state.doc.sliceString(0, word.from);
	if (word.from === word.to && !context.explicit && !before.endsWith('.')) {
		return null;
	}

	if (before.endsWith('.')) {
		const receiver = before.slice(0, -1);
		const options = /(?:^|[^\w.])values$/.test(receiver)
			? toCompletions(VALUES_MEMBERS, 'method')
			: toCompletions(RESULT_MEMBERS, 'method');
		return { from: word.from, options, validFor: /^\w*$/ };
	}

	const options = [
		...toCompletions(GLOBAL_ITEMS, 'variable'),
		...PRESET_SUMMARIES.map((item) => toCompletion(item, 'text', -1)),
	];
	return { from: word.from, options, validFor: /^\w*$/ };
}

export interface FormulaEditorOptions {
	initialValue?: string;
	placeholder?: string;
	onChange: (value: string) => void;
	onSubmit?: () => void;
}

export function createFormulaEditor(parent: HTMLElement, options: FormulaEditorOptions): EditorView {
	return new EditorView({
		parent,
		state: EditorState.create({
			doc: options.initialValue ?? '',
			extensions: [
				EditorView.contentAttributes.of({ 'aria-label': 'Formula', spellcheck: 'false' }),
				EditorView.lineWrapping,
				tooltips({ parent: activeDocument.body }),
				placeholderExtension(options.placeholder ?? ''),
				autocompletion({
					override: [formulaCompletions],
					activateOnTyping: true,
					icons: false,
				}),
				keymap.of([
					...completionKeymap,
					{
						key: 'Enter',
						run: () => {
							options.onSubmit?.();
							return true;
						},
					},
				]),
				EditorState.transactionFilter.of((transaction) =>
					transaction.docChanged && transaction.newDoc.lines > 1 ? [] : transaction,
				),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) {
						options.onChange(update.state.doc.toString());
					}
				}),
			],
		}),
	});
}
