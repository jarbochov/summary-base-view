import { Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, SummaryBaseViewSettings, SummaryBaseViewSettingTab } from './settings';
import { parseExcludedFolders } from './summary-core';
import { SHOW_SUMMARY_ROW_KEY, SUMMARY_VIEW_TYPE, SummaryBasesView } from './summary-view';

export default class SummaryBaseViewPlugin extends Plugin {
	settings: SummaryBaseViewSettings = { ...DEFAULT_SETTINGS };
	private readonly views = new Set<SummaryBasesView>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new SummaryBaseViewSettingTab(this.app, this));
		this.registerBasesView(SUMMARY_VIEW_TYPE, {
			name: 'Summary',
			icon: 'lucide-table-properties',
			options: () => [
				{ type: 'toggle', key: SHOW_SUMMARY_ROW_KEY, displayName: 'Show summary row', default: true },
			],
			factory: (controller, containerEl) => {
				const view = new SummaryBasesView(
					controller,
					containerEl,
					() => parseExcludedFolders(this.settings.excludedFolders),
				);
				this.views.add(view);
				view.register(() => this.views.delete(view));
				return view;
			},
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<SummaryBaseViewSettings> | null);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		for (const view of this.views) {
			view.onDataUpdated();
		}
	}
}
