import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

type OutputType = 'slides' | 'poster';
type StylePreset = 'academic' | 'doraemon' | 'custom';
type ContentType = 'paper' | 'general';

interface Paper2SlidesSettings {
	pythonPath: string;
	p2sPath: string;
	outputType: OutputType;
	style: StylePreset;
	customStyle: string;
	fastMode: boolean;
}

const DEFAULT_SETTINGS: Paper2SlidesSettings = {
	pythonPath: 'python3',
	p2sPath: '',
	outputType: 'slides',
	style: 'doraemon',
	customStyle: '',
	fastMode: false,
};

export default class Paper2SlidesPlugin extends Plugin {
	settings: Paper2SlidesSettings;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new Paper2SlidesSettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFile && this.isSupportedSource(file)) {
					menu.addItem((item) => {
						item
							.setTitle('Generate Slides/Poster (Paper2Slides)')
							.setIcon('presentation')
							.onClick(async () => {
								await this.generateSlides(file);
							});
					});
				}
			}),
		);

		this.addCommand({
			id: 'generate-slides-current-file',
			name: 'Generate Slides/Poster from current file',
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (file && this.isSupportedSource(file)) {
					if (!checking) {
						void this.generateSlides(file);
					}
					return true;
				}
				return false;
			},
		});
	}

	private isSupportedSource(file: TFile): boolean {
		return file.extension === 'pdf' || file.extension === 'md';
	}

	private getContentType(file: TFile): ContentType {
		return file.extension === 'md' ? 'general' : 'paper';
	}

	private getStyleArgument(): string {
		if (this.settings.style === 'custom') {
			const prompt = this.settings.customStyle.trim();
			return prompt.length > 0 ? prompt : 'minimal clean academic presentation';
		}

		return this.settings.style;
	}

	private getConfigDirName(): string {
		const style = this.settings.style === 'custom'
			? `custom_${this.settings.customStyle.trim().slice(0, 16).replace(/ /g, '_').replace(/\//g, '_') || 'custom'}`
			: this.settings.style;
		const detail = this.settings.outputType === 'poster' ? 'medium' : 'short';
		return `${this.settings.outputType}_${style}_${detail}`;
	}

	private async ensureVaultFolder(folderPath: string): Promise<void> {
		if (folderPath === '.' || folderPath === '' || await this.app.vault.adapter.exists(folderPath)) {
			return;
		}

		const parent = path.posix.dirname(folderPath);
		if (parent !== folderPath) {
			await this.ensureVaultFolder(parent);
		}
		await this.app.vault.createFolder(folderPath);
	}

	async generateSlides(file: TFile) {
		const repoPath = this.settings.p2sPath.trim();
		if (!repoPath) {
			new Notice('Set the Paper2Slides repo path in the plugin settings first.');
			return;
		}

		if (!fs.existsSync(repoPath)) {
			new Notice('The configured Paper2Slides repo path does not exist.');
			return;
		}

		if (!fs.existsSync(path.join(repoPath, 'paper2slides'))) {
			new Notice('The repo path looks wrong. Expected a folder containing the paper2slides package.');
			return;
		}

		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice('Only local vaults are supported right now.');
			return;
		}

		const fullInputPath = path.join(adapter.getBasePath(), file.path);
		const contentType = this.getContentType(file);
		const styleArg = this.getStyleArgument();

		new Notice(`Starting Paper2Slides for ${file.name}...`);

		const args = [
			'-m', 'paper2slides',
			'--input', fullInputPath,
			'--content', contentType,
			'--output', this.settings.outputType,
			'--style', styleArg,
		];

		if (this.settings.fastMode) {
			args.push('--fast');
		}

		console.log(`Running: ${this.settings.pythonPath} ${args.join(' ')}`);

		const p2sProcess = spawn(this.settings.pythonPath, args, {
			cwd: repoPath,
			env: { ...process.env },
		});

		p2sProcess.on('error', (error) => {
			console.error('Paper2Slides process error:', error);
			new Notice(`Could not start ${this.settings.pythonPath}. Check the Python command in settings.`);
		});

		p2sProcess.stdout.on('data', (data) => {
			const output = data.toString();
			console.log(`Paper2Slides stdout: ${output}`);
			const lines = output.split('\n');
			for (const line of lines) {
				if (line.includes('Starting Stage:')) {
					new Notice(`Paper2Slides: ${line.trim()}`);
				}
			}
		});

		p2sProcess.stderr.on('data', (data) => {
			console.error(`Paper2Slides stderr: ${data}`);
		});

		p2sProcess.on('close', async (code) => {
			if (code === 0) {
				new Notice('Paper2Slides finished. Importing the newest result into the vault...');
				await this.importLatestOutputs(file, contentType);
			} else {
				new Notice(`Paper2Slides failed with exit code ${code}. Open the developer console for logs.`);
			}
		});
	}

	private collectGeneratedFiles(dir: string): string[] {
		if (!fs.existsSync(dir)) {
			return [];
		}

		const collected: string[] = [];
		for (const name of fs.readdirSync(dir)) {
			const currentPath = path.join(dir, name);
			const stat = fs.statSync(currentPath);
			if (stat.isDirectory()) {
				collected.push(...this.collectGeneratedFiles(currentPath));
				continue;
			}

			if (name.endsWith('.pdf') || name.endsWith('.png') || name.endsWith('.md')) {
				collected.push(currentPath);
			}
		}

		return collected;
	}

	private getLatestTimestampDir(configDir: string): string | null {
		if (!fs.existsSync(configDir)) {
			return null;
		}

		const candidates = fs.readdirSync(configDir)
			.map((name) => path.join(configDir, name))
			.filter((candidate) => fs.statSync(candidate).isDirectory())
			.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));

		return candidates[0] ?? null;
	}

	private async writeVaultFile(vaultPath: string, sourcePath: string): Promise<void> {
		const data = fs.readFileSync(sourcePath);
		if (sourcePath.endsWith('.md')) {
			const content = data.toString('utf8');
			if (await this.app.vault.adapter.exists(vaultPath)) {
				await this.app.vault.adapter.write(vaultPath, content);
			} else {
				await this.app.vault.create(vaultPath, content);
			}
			return;
		}

		const binary = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
		if (await this.app.vault.adapter.exists(vaultPath)) {
			await this.app.vault.adapter.writeBinary(vaultPath, binary);
		} else {
			await this.app.vault.createBinary(vaultPath, binary);
		}
	}

	async importLatestOutputs(sourceFile: TFile, contentType: ContentType) {
		const projectDir = path.join(this.settings.p2sPath, 'outputs', sourceFile.basename, contentType);
		const modeDir = path.join(projectDir, this.settings.fastMode ? 'fast' : 'normal');
		const configDir = path.join(modeDir, this.getConfigDirName());
		const latestRunDir = this.getLatestTimestampDir(configDir);
		const summaryPath = path.join(modeDir, 'summary.md');

		const sourcePaths = new Set<string>();
		if (fs.existsSync(summaryPath)) {
			sourcePaths.add(summaryPath);
		}
		if (latestRunDir) {
			for (const filePath of this.collectGeneratedFiles(latestRunDir)) {
				sourcePaths.add(filePath);
			}
		}

		if (sourcePaths.size === 0) {
			new Notice('Paper2Slides finished, but no output files were found to import.');
			return;
		}

		const targetDir = path.posix.join('Paper2Slides', sourceFile.basename);
		await this.ensureVaultFolder(targetDir);

		let importedCount = 0;
		for (const sourcePath of sourcePaths) {
			const fileName = path.basename(sourcePath);
			const vaultPath = path.posix.join(targetDir, fileName);
			await this.writeVaultFile(vaultPath, sourcePath);
			importedCount += 1;
		}

		new Notice(`Imported ${importedCount} files into ${targetDir}`);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class Paper2SlidesSettingTab extends PluginSettingTab {
	plugin: Paper2SlidesPlugin;

	constructor(app: App, plugin: Paper2SlidesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		containerEl.createEl('h2', { text: 'Paper2Slides settings' });

		new Setting(containerEl)
			.setName('Python command')
			.setDesc('Usually python3. Point this to your venv only if you really need to.')
			.addText((text) => text
				.setPlaceholder('python3')
				.setValue(this.plugin.settings.pythonPath)
				.onChange(async (value) => {
					this.plugin.settings.pythonPath = value.trim() || 'python3';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Paper2Slides repo path')
			.setDesc('Absolute path to your cloned Paper2Slides checkout.')
			.addText((text) => text
				.setPlaceholder('/path/to/Paper2Slides')
				.setValue(this.plugin.settings.p2sPath)
				.onChange(async (value) => {
					this.plugin.settings.p2sPath = value.trim();
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Generation' });

		new Setting(containerEl)
			.setName('Output type')
			.setDesc('Generate either slides or a poster.')
			.addDropdown((dropdown) => dropdown
				.addOption('slides', 'Slides')
				.addOption('poster', 'Poster')
				.setValue(this.plugin.settings.outputType)
				.onChange(async (value: OutputType) => {
					this.plugin.settings.outputType = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Style preset')
			.setDesc('Use one of the built-in styles, or switch to custom and type your own prompt below.')
			.addDropdown((dropdown) => dropdown
				.addOption('academic', 'Academic')
				.addOption('doraemon', 'Doraemon')
				.addOption('custom', 'Custom')
				.setValue(this.plugin.settings.style)
				.onChange(async (value: StylePreset) => {
					this.plugin.settings.style = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.style === 'custom') {
			new Setting(containerEl)
				.setName('Custom style prompt')
				.setDesc('Passed straight through to Paper2Slides as the style argument.')
				.addTextArea((text) => text
					.setPlaceholder('Clean editorial slides with warm neutrals and subtle diagrams.')
					.setValue(this.plugin.settings.customStyle)
					.onChange(async (value) => {
						this.plugin.settings.customStyle = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Fast mode')
			.setDesc('Skip RAG indexing. Good for quick passes and smaller inputs.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.fastMode)
				.onChange(async (value) => {
					this.plugin.settings.fastMode = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('p', {
			text: 'PDF files run as paper mode. Markdown notes run as general mode automatically.',
		});
	}
}
