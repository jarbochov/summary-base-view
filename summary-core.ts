export interface SummaryGroup<TEntry, TKey> {
	key?: TKey | null;
	entries: readonly TEntry[];
	hasKey?: () => boolean;
}

export const COUNT_COLUMN_ID = '$count';

export interface SummaryColumn {
	id: string;
	propertyId: string | null;
	summaryKey?: string;
}

export interface SummaryColumnConfig {
	type?: 'count';
	property?: string;
	summary?: string;
}

export interface SummaryRow<TKey, TValue> {
	key: TKey;
	count: number;
	values: Array<TValue | null>;
}

export interface SummarySortOptions {
	direction: 'ASC' | 'DESC';
	groupOrder?: readonly string[];
	columnIndex?: number;
	columnDirection?: 'ASC' | 'DESC';
	countDirection?: 'ASC' | 'DESC';
}

export function sortSummaryRows<TKey, TValue>(
	rows: readonly SummaryRow<TKey, TValue>[],
	toString: (value: TKey | TValue | null) => string,
	options: SummarySortOptions,
): SummaryRow<TKey, TValue>[] {
	const direction = options.direction === 'DESC' ? -1 : 1;
	const columnDirection = options.columnDirection === 'DESC' ? -1 : 1;
	const countDirection = options.countDirection === 'DESC' ? -1 : 1;
	const groupOrderIndex = new Map((options.groupOrder ?? []).map((value, index) => [value, index]));

	return [...rows].sort((left, right) => {
		if (options.countDirection) {
			const countDifference = (left.count - right.count) * countDirection;
			if (countDifference !== 0) {
				return countDifference;
			}
		}

		const leftOrder = groupOrderIndex.get(toString(left.key));
		const rightOrder = groupOrderIndex.get(toString(right.key));
		if (leftOrder !== undefined || rightOrder !== undefined) {
			if (leftOrder === undefined) {
				return 1;
			}
			if (rightOrder === undefined) {
				return -1;
			}
			if (leftOrder !== rightOrder) {
				return leftOrder - rightOrder;
			}
		}

		if (options.columnIndex !== undefined) {
			return toString(left.values[options.columnIndex]).localeCompare(
				toString(right.values[options.columnIndex]),
				undefined,
				{ numeric: true, sensitivity: 'base' },
			) * columnDirection;
		}

		return toString(left.key).localeCompare(toString(right.key), undefined, {
			numeric: true,
			sensitivity: 'base',
		}) * direction;
	});
}

export function expandSummaryGroups<TEntry, TKey>(
	groups: readonly SummaryGroup<TEntry, TKey>[],
	expandKey: (key: TKey) => readonly TKey[],
	keysEqual: (left: TKey, right: TKey) => boolean,
): SummaryGroup<TEntry, TKey>[] {
	const expandedGroups: Array<{ key: TKey; entries: TEntry[] }> = [];

	for (const group of groups) {
		const key = group.key;
		if (key === null || key === undefined || (group.hasKey && !group.hasKey())) {
			continue;
		}

		for (const expandedKey of expandKey(key)) {
			let target = expandedGroups.find((candidate) => keysEqual(candidate.key, expandedKey));
			if (!target) {
				target = { key: expandedKey, entries: [] };
				expandedGroups.push(target);
			}

			for (const entry of group.entries) {
				if (!target.entries.includes(entry)) {
					target.entries.push(entry);
				}
			}
		}
	}

	return expandedGroups;
}

export function readSummaryConfig(value: unknown): Record<string, string> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}

	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0,
		),
	);
}

export function normalizePropertyId(value: unknown, availableProperties: readonly string[]): string | null {
	if (typeof value !== 'string' || value.length === 0) {
		return null;
	}

	if (availableProperties.includes(value)) {
		return value;
	}

	const noteProperty = `note.${value}`;
	if (availableProperties.includes(noteProperty)) {
		return noteProperty;
	}

	const matches = availableProperties.filter((propertyId) => propertyId.endsWith(`.${value}`));
	return matches.length === 1 ? matches[0] : null;
}

export function normalizeSummaryConfig(
	value: unknown,
	availableProperties: readonly string[],
): Record<string, string> {
	const summaries: Record<string, string> = {};
	for (const [property, summaryKey] of Object.entries(readSummaryConfig(value))) {
		const propertyId = normalizePropertyId(property, availableProperties);
		if (propertyId) {
			summaries[propertyId] = summaryKey;
		}
	}
	return summaries;
}

export function readSummaryColumns(value: unknown): SummaryColumnConfig[] | null {
	if (!Array.isArray(value)) {
		return null;
	}

	return value.flatMap((item): SummaryColumnConfig[] => {
		if (item === null || typeof item !== 'object' || Array.isArray(item)) {
			return [];
		}
		const record = item as Record<string, unknown>;
		if (record.type === 'count') {
			return [{ type: 'count' }];
		}
		if (typeof record.property !== 'string' || record.property.length === 0) {
			return [];
		}
		return [{
			property: record.property,
			summary: typeof record.summary === 'string' && record.summary.trim().length > 0
				? record.summary
				: undefined,
		}];
	});
}

export function summaryColumnsToConfig(columns: readonly SummaryColumn[]): SummaryColumnConfig[] {
	return columns.map((column) => column.propertyId === null
		? { type: 'count' }
		: { property: column.propertyId, summary: column.summaryKey });
}

export function buildSummaryColumns(
	properties: readonly string[],
	groupByProperty: string | null,
	summaries: Readonly<Record<string, string>>,
	configured: readonly SummaryColumnConfig[] | null = null,
	availableProperties: readonly string[] = properties,
): SummaryColumn[] {
	const visible = properties.filter((propertyId) => propertyId !== groupByProperty);
	const columns: SummaryColumn[] = [];
	const seen = new Map<string, number>();
	const addProperty = (propertyId: string, summaryKey: string | undefined): void => {
		const occurrence = (seen.get(propertyId) ?? 0) + 1;
		seen.set(propertyId, occurrence);
		columns.push({
			id: occurrence === 1 ? propertyId : `${propertyId}~${occurrence}`,
			propertyId,
			summaryKey,
		});
	};

	if (!configured) {
		columns.push({ id: COUNT_COLUMN_ID, propertyId: null });
		for (const propertyId of visible) {
			addProperty(propertyId, summaries[propertyId]);
		}
		return columns;
	}

	let hasCount = false;
	for (const item of configured) {
		if (item.type === 'count') {
			if (!hasCount) {
				hasCount = true;
				columns.push({ id: COUNT_COLUMN_ID, propertyId: null });
			}
			continue;
		}
		const propertyId = normalizePropertyId(item.property, availableProperties);
		if (propertyId && visible.includes(propertyId)) {
			addProperty(propertyId, item.summary);
		}
	}
	for (const propertyId of visible) {
		if (!seen.has(propertyId)) {
			addProperty(propertyId, summaries[propertyId]);
		}
	}
	return columns;
}

export function buildSummaryRows<TEntry, TKey, TValue>(
	groups: readonly SummaryGroup<TEntry, TKey>[],
	columns: readonly SummaryColumn[],
	summarize: (entries: readonly TEntry[], propertyId: string, summaryKey: string) => TValue,
	excludeEntry: (entry: TEntry) => boolean,
): SummaryRow<TKey, TValue>[] {
	const rows: SummaryRow<TKey, TValue>[] = [];

	for (const group of groups) {
		const key = group.key;
		if (key === null || key === undefined || (group.hasKey && !group.hasKey())) {
			continue;
		}

		const entries = group.entries.filter((entry) => !excludeEntry(entry));
		if (entries.length === 0) {
			continue;
		}

		rows.push({
			key,
			count: entries.length,
			values: columns.map(({ propertyId, summaryKey }) =>
				propertyId !== null && summaryKey ? summarize(entries, propertyId, summaryKey) : null,
			),
		});
	}

	return rows;
}

export function serializeCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
	const escapeField = (field: string): string => {
		const escaped = field.replace(/"/g, '""');
		return /[",\r\n]/.test(field) ? `"${escaped}"` : escaped;
	};

	return [headers, ...rows]
		.map((row) => row.map(escapeField).join(','))
		.join('\r\n');
}

export function parseExcludedFolders(value: string): string[] {
	return value
		.split(/[\n,]/)
		.map((item) => item.trim().replace(/^\/+|\/+$/g, ''))
		.filter((item) => item.length > 0);
}

// A bare name matches a folder with that name anywhere in the path; a name containing "/" matches a path prefix.
export function isExcludedPath(path: string, excludedFolders: readonly string[]): boolean {
	const folders = path.split('/').slice(0, -1);
	const folderPath = folders.join('/');
	return excludedFolders.some((excluded) => excluded.includes('/')
		? folderPath === excluded || folderPath.startsWith(`${excluded}/`)
		: folders.includes(excluded));
}
