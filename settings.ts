import { App, PluginSettingTab, Setting, SettingDefinitionItem } from 'obsidian';
import type SummaryBaseViewPlugin from './main';

const EXCLUDED_FOLDERS_NAME = 'Excluded folders';
const EXCLUDED_FOLDERS_DESC = 'Notes in these folders are left out of group counts and summaries. Enter one folder name per line. A name matches a folder with that name anywhere; a path such as Archive/Old matches that folder and its subfolders. Leave empty to include everything.';

export interface SummaryBaseViewSettings {
	excludedFolders: string;
}

export const DEFAULT_SETTINGS: SummaryBaseViewSettings = {
	excludedFolders: 'Templates',
};

export class SummaryBaseViewSettingTab extends PluginSettingTab {
	plugin: SummaryBaseViewPlugin;

	constructor(app: App, plugin: SummaryBaseViewPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName(EXCLUDED_FOLDERS_NAME)
			.setDesc(EXCLUDED_FOLDERS_DESC)
			.addTextArea((text) => {
				text.setPlaceholder('Templates');
				text.setValue(this.plugin.settings.excludedFolders);
				text.onChange(async (value) => {
					this.plugin.settings.excludedFolders = value;
					await this.plugin.saveSettings();
				});
			});
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: EXCLUDED_FOLDERS_NAME,
				desc: EXCLUDED_FOLDERS_DESC,
				control: {
					type: 'textarea',
					key: 'excludedFolders',
					placeholder: 'Templates',
					rows: 4,
				},
			},
		];
	}

	setControlValue(key: string, value: unknown): Promise<void> {
		if (key === 'excludedFolders' && typeof value === 'string') {
			this.plugin.settings.excludedFolders = value;
		}
		return this.plugin.saveSettings();
	}
}
