import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'summary-base-view-smoke-'));
const bundlePath = path.join(tempDir, 'summary-core-test.cjs');

try {
	buildSync({
		entryPoints: ['summary-core.ts'],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: 'node18',
		outfile: bundlePath,
	});

	const core = await import(pathToFileURL(bundlePath).href);
	const summaryConfig = core.readSummaryConfig({
		'note.author': 'Unique',
		'note.rating': 'Average',
		'file.name': '',
		invalid: 42,
	});
	assert.deepEqual(summaryConfig, {
		'note.author': 'Unique',
		'note.rating': 'Average',
	});
	assert.equal(core.normalizePropertyId('media', ['note.media', 'file.name']), 'note.media');
	assert.deepEqual(
		core.normalizeSummaryConfig({ author: 'Unique' }, ['note.author']),
		{ 'note.author': 'Unique' },
	);

	const columns = core.buildSummaryColumns(
		['note.media', 'note.author', 'note.rating'],
		'note.media',
		summaryConfig,
	);
	assert.deepEqual(columns, [
		{ id: '$count', propertyId: null },
		{ id: 'note.author', propertyId: 'note.author', summaryKey: 'Unique' },
		{ id: 'note.rating', propertyId: 'note.rating', summaryKey: 'Average' },
	]);
	assert.deepEqual(
		core.buildSummaryColumns(['note.media', 'note.author'], 'note.media', {}),
		[
			{ id: '$count', propertyId: null },
			{ id: 'note.author', propertyId: 'note.author', summaryKey: undefined },
		],
	);

	const configured = core.readSummaryColumns([
		{ property: 'note.rating', summary: 'Sum' },
		{ property: 'note.rating', summary: 'Average' },
		{ type: 'count' },
		{ property: 'note.gone', summary: 'Sum' },
		42,
	]);
	const multi = core.buildSummaryColumns(
		['note.media', 'note.author', 'note.rating'],
		'note.media',
		{},
		configured,
		['note.media', 'note.author', 'note.rating'],
	);
	assert.deepEqual(multi.map((column) => [column.id, column.summaryKey]), [
		['note.rating', 'Sum'],
		['note.rating~2', 'Average'],
		['$count', undefined],
		['note.author', undefined],
	]);
	assert.deepEqual(
		core.buildSummaryColumns(['note.author'], null, {}, [{ property: 'note.author', summary: 'Unique' }]),
		[{ id: 'note.author', propertyId: 'note.author', summaryKey: 'Unique' }],
	);

	const sourceGroups = [
		{ key: ['Book', 'Audio'], entries: [{ path: 'Books/One.md' }] },
		{ key: ['Book'], entries: [{ path: 'Books/Two.md' }] },
		{ key: ['Film'], entries: [{ path: 'Films/One.md' }] },
		{ key: null, entries: [{ path: 'No-Media.md' }] },
		{ key: ['Empty'], entries: [{ path: 'Templates/Example.md' }] },
	];
	const groups = core.expandSummaryGroups(
		sourceGroups,
		(key) => Array.isArray(key) ? key : [key],
		(left, right) => left === right,
	);
	const rows = core.buildSummaryRows(
		groups,
		columns,
		(entries, propertyId, summaryKey) => `${propertyId}:${summaryKey}:${entries.length}`,
		(entry) => entry.path.split('/').slice(0, -1).includes('Templates'),
	);

	assert.deepEqual(core.parseExcludedFolders(' Templates,\n\\Archive\\Old\\ \n'), ['Templates', 'Archive/Old']);
	assert.equal(core.isExcludedPath('A/Templates/x.md', ['Templates']), true);
	assert.equal(core.isExcludedPath('A/TemplatesX/x.md', ['Templates']), false);
	assert.equal(core.isExcludedPath('Archive/Old/Sub/x.md', ['Archive/Old']), true);
	assert.equal(core.isExcludedPath('Archive/Older/x.md', ['Archive/Old']), false);
	assert.equal(core.isExcludedPath('Templates/x.md', []), false);

	const expandedWithEmpty = core.expandSummaryGroups(
		sourceGroups,
		(key) => Array.isArray(key) ? key : [key],
		(left, right) => left === right,
		'(Empty)',
	);
	const rowsWithEmpty = core.buildSummaryRows(
		expandedWithEmpty,
		columns,
		(entries, propertyId, summaryKey) => `${propertyId}:${summaryKey}:${entries.length}`,
		(entry) => entry.path.split('/').slice(0, -1).includes('Templates'),
		true,
	);
	assert.equal(rowsWithEmpty.length, 4);
	assert.equal(rowsWithEmpty[3].key, '(Empty)');
	assert.equal(rowsWithEmpty[3].count, 1);

	const numericRows = [
		{ key: 'Neg', count: 1, values: [-10] },
		{ key: 'Small', count: 1, values: [1.9] },
		{ key: 'Mid', count: 1, values: [1.15] },
		{ key: 'Empty', count: 1, values: [null] },
	];
	const getNumericSortKey = (value) => value === null
		? { empty: true, text: '' }
		: typeof value === 'number'
			? { empty: false, num: value, text: String(value) }
			: { empty: false, text: String(value) };
	assert.deepEqual(
		core.sortSummaryRows(numericRows, String, {
			direction: 'ASC',
			columnIndex: 0,
			columnDirection: 'ASC',
			getSortKey: getNumericSortKey,
		}).map((row) => row.key),
		['Neg', 'Mid', 'Small', 'Empty'],
	);
	assert.deepEqual(
		core.sortSummaryRows(numericRows, String, {
			direction: 'ASC',
			columnIndex: 0,
			columnDirection: 'DESC',
			getSortKey: getNumericSortKey,
		}).map((row) => row.key),
		['Small', 'Mid', 'Neg', 'Empty'],
	);

	const syncedOrder = core.syncSummaryColumnsOrder(
		[
			{ type: 'count' },
			{ property: 'note.amount', summary: 'Sum' },
			{ property: 'note.amount', summary: 'Average' },
			{ property: 'note.rating', summary: 'Max' },
		],
		['note.rating', 'note.amount'],
	);
	assert.deepEqual(syncedOrder, [
		{ type: 'count' },
		{ property: 'note.rating', summary: 'Max' },
		{ property: 'note.amount', summary: 'Sum' },
		{ property: 'note.amount', summary: 'Average' },
	]);

	assert.equal(rows.length, 3);
	assert.equal(rows[0].key, 'Book');
	assert.equal(rows[0].count, 2);
	assert.deepEqual(rows[0].values, [
		null,
		'note.author:Unique:2',
		'note.rating:Average:2',
	]);
	assert.equal(rows[1].key, 'Audio');
	assert.equal(rows[1].count, 1);
	assert.equal(rows[2].key, 'Film');
	assert.equal(rows[2].count, 1);
	const unconfiguredRows = core.buildSummaryRows(
		groups,
		[{ id: 'note.author', propertyId: 'note.author' }],
		() => 'unused',
		(entry) => entry.path.split('/').slice(0, -1).includes('Templates'),
	);
	assert.equal(unconfiguredRows[0].values[0], null);
	const sortableRows = [
		{ key: 'Book', count: 2, values: ['3'] },
		{ key: 'Audio', count: 1, values: ['4'] },
		{ key: 'Film', count: 1, values: ['5'] },
	];
	assert.deepEqual(
		core.sortSummaryRows(sortableRows, String, { direction: 'ASC' }).map((row) => row.key),
		['Audio', 'Book', 'Film'],
	);
	assert.deepEqual(
		core.sortSummaryRows(sortableRows, String, {
			direction: 'DESC',
			groupOrder: ['Book', 'Audio'],
		}).map((row) => row.key),
		['Book', 'Audio', 'Film'],
	);
	assert.deepEqual(
		core.sortSummaryRows(sortableRows, String, {
			direction: 'ASC',
			columnIndex: 0,
			columnDirection: 'DESC',
		}).map((row) => row.key),
		['Film', 'Audio', 'Book'],
	);
	assert.deepEqual(
		core.sortSummaryRows(sortableRows, String, {
			direction: 'ASC',
			countDirection: 'DESC',
		}).map((row) => row.key),
		['Book', 'Audio', 'Film'],
	);
	assert.equal(
		core.serializeCsv(['Group', 'Count', 'Author'], [['Book, Audio', '2', 'Alpha "A"']]),
		'Group,Count,Author\r\n"Book, Audio",2,"Alpha ""A"""',
	);
	assert.equal(
		core.serializeMarkdownTable(['Group', 'Notes'], [['A | B', 'line1\nline2']]),
		'| Group | Notes |\n| --- | --- |\n| A \\| B | line1 line2 |',
	);

	console.log('Smoke test passed.');
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
