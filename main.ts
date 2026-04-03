import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

type OutputType = 'slides' | 'poster';
type StylePreset = 'academic' | 'doraemon' | 'custom';
type ContentType = 'paper' | 'general';
type SlidesLength = 'short' | 'medium' | 'long';
type PosterDensity = 'sparse' | 'medium' | 'dense';

interface Paper2SlidesSettings {
	pythonPath: string;
	p2sPath: string;
	outputType: OutputType;
	style: StylePreset;
	customStyle: string;
	slidesLength: SlidesLength;
	posterDensity: PosterDensity;
	fastMode: boolean;
	parallelWorkers: number;
	importRoot: string;
	saveRunLog: boolean;
}

interface RunContext {
	file: TFile;
	contentType: ContentType;
	process: ChildProcess;
	startedAt: number;
	targetDir: string;
	logLines: string[];
}

interface ValidationResult {
	ok: boolean;
	lines: string[];
}

const DEFAULT_SETTINGS: Paper2SlidesSettings = {
	pythonPath: 'python3',
	p2sPath: '',
	outputType: 'slides',
	style: 'doraemon',
	customStyle: '',
	slidesLength: 'short',
	posterDensity: 'medium',
	fastMode: false,
	parallelWorkers: 1,
	importRoot: 'Paper2Slides',
	saveRunLog: true,
};

const TIMESTAMP_DIR_PATTERN = /^\d{8}_\d{6}$/;

export default class Paper2SlidesPlugin extends Plugin {
	settings: Paper2SlidesSettings;
	activeRun: RunContext | null = null;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('presentation', 'Generate with Paper2Slides', async () => {
			const file = this.app.workspace.getActiveFile();
			if (!file || !this.isSupportedSource(file)) {
				new Notice('Open a PDF or Markdown note first.');
				return;
			}
			await this.generateSlides(file);
		});

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

					menu.addItem((item) => {
						item
							.setTitle('Re-import latest Paper2Slides outputs')
							.setIcon('sync')
							.onClick(async () => {
								await this.reimportLatestOutputs(file);
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

		this.addCommand({
			id: 'reimport-latest-outputs-current-file',
			name: 'Re-import latest Paper2Slides outputs for current file',
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (file && this.isSupportedSource(file)) {
					if (!checking) {
						void this.reimportLatestOutputs(file);
					}
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: 'check-paper2slides-setup',
			name: 'Check Paper2Slides setup',
			callback: async () => {
				await this.runSetupCheck(true);
			},
		});

		this.addCommand({
			id: 'stop-paper2slides-run',
			name: 'Stop current Paper2Slides run',
			checkCallback: (checking: boolean) => {
				if (this.activeRun) {
					if (!checking) {
						void this.stopCurrentRun();
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

	private getVaultImportRoot(): string {
		return this.settings.importRoot.trim().replace(/^\/+|\/+$/g, '') || 'Paper2Slides';
	}

	private getTargetDir(sourceFile: TFile): string {
		return path.posix.join(this.getVaultImportRoot(), sourceFile.basename);
	}

	private appendLogLine(run: RunContext, line: string): void {
		if (line.trim().length > 0) {
			run.logLines.push(line);
		}
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

	private async validateSetup(showNotice = false): Promise<ValidationResult> {
		const lines: string[] = [];
		let ok = true;

		const repoPath = this.settings.p2sPath.trim();
		if (!repoPath) {
			ok = false;
			lines.push('Missing repo path.');
		} else if (!fs.existsSync(repoPath)) {
			ok = false;
			lines.push('Repo path does not exist.');
		} else if (!fs.existsSync(path.join(repoPath, 'paper2slides'))) {
			ok = false;
			lines.push('Repo path does not look like a Paper2Slides checkout.');
		} else {
			lines.push('Repo path looks valid.');
		}

		const envPath = repoPath ? path.join(repoPath, 'paper2slides', '.env') : '';
		if (envPath && fs.existsSync(envPath)) {
			lines.push('Found paper2slides/.env.');
		} else {
			ok = false;
			lines.push('Missing paper2slides/.env.');
		}

		if (repoPath) {
			const pythonVersion = await this.runCommand(this.settings.pythonPath, ['--version'], repoPath);
			if (pythonVersion.ok) {
				lines.push(`Python command works: ${pythonVersion.output.trim()}`);
			} else {
				ok = false;
				lines.push(`Python command failed: ${pythonVersion.output.trim() || this.settings.pythonPath}`);
			}

			const cliCheck = await this.runCommand(this.settings.pythonPath, ['-m', 'paper2slides', '--help'], repoPath);
			if (cliCheck.ok) {
				lines.push('paper2slides CLI starts.');
			} else {
				ok = false;
				lines.push('paper2slides CLI did not start.');
			}
		}

		if (showNotice) {
			const prefix = ok ? 'Paper2Slides setup looks good.' : 'Paper2Slides setup still needs fixes.';
			new Notice([prefix, ...lines].join('\n'), 12000);
		}

		return { ok, lines };
	}

	private async runCommand(command: string, args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
		return await new Promise((resolve) => {
			const child = spawn(command, args, { cwd, env: { ...process.env } });
			let output = '';

			child.stdout.on('data', (data) => {
				output += data.toString();
			});

			child.stderr.on('data', (data) => {
				output += data.toString();
			});

			child.on('error', (error) => {
				resolve({ ok: false, output: error.message });
			});

			child.on('close', (code) => {
				resolve({ ok: code === 0, output });
			});
		});
	}

	async runSetupCheck(showNotice = true): Promise<boolean> {
		const result = await this.validateSetup(showNotice);
		return result.ok;
	}

	private buildCliArgs(fullInputPath: string, contentType: ContentType): string[] {
		const args = [
			'-m', 'paper2slides',
			'--input', fullInputPath,
			'--content', contentType,
			'--output', this.settings.outputType,
			'--style', this.getStyleArgument(),
		];

		if (this.settings.outputType === 'slides') {
			args.push('--length', this.settings.slidesLength);
		} else {
			args.push('--density', this.settings.posterDensity);
		}

		if (this.settings.fastMode) {
			args.push('--fast');
		}

		if (this.settings.parallelWorkers > 1) {
			args.push('--parallel', String(this.settings.parallelWorkers));
		}

		return args;
	}

	async generateSlides(file: TFile) {
		if (this.activeRun) {
			new Notice(`A Paper2Slides run is already active for ${this.activeRun.file.name}. Stop it first or wait for it to finish.`);
			return;
		}

		const setupOk = await this.runSetupCheck(false);
		if (!setupOk) {
			await this.runSetupCheck(true);
			return;
		}

		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice('Only local vaults are supported right now.');
			return;
		}

		const repoPath = this.settings.p2sPath.trim();
		const fullInputPath = path.join(adapter.getBasePath(), file.path);
		const contentType = this.getContentType(file);
		const args = this.buildCliArgs(fullInputPath, contentType);
		const targetDir = this.getTargetDir(file);

		new Notice(`Starting Paper2Slides for ${file.name}...`, 6000);

		const processHandle = spawn(this.settings.pythonPath, args, {
			cwd: repoPath,
			env: { ...process.env },
		});

		const run: RunContext = {
			file,
			contentType,
			process: processHandle,
			startedAt: Date.now(),
			targetDir,
			logLines: [
				`Command: ${this.settings.pythonPath} ${args.join(' ')}`,
				`Started: ${new Date().toISOString()}`,
			],
		};

		this.activeRun = run;

		processHandle.on('error', async (error) => {
			this.appendLogLine(run, `Process error: ${error.message}`);
			await this.writeRunLog(run, false);
			this.activeRun = null;
			new Notice(`Could not start ${this.settings.pythonPath}. Check the Python command in settings.`);
		});

		processHandle.stdout.on('data', (data) => {
			const output = data.toString();
			console.log(`Paper2Slides stdout: ${output}`);
			for (const line of output.split('\n')) {
				this.appendLogLine(run, line);
				if (line.includes('Starting Stage:')) {
					new Notice(`Paper2Slides: ${line.trim()}`, 4000);
				}
			}
		});

		processHandle.stderr.on('data', (data) => {
			const output = data.toString();
			console.error(`Paper2Slides stderr: ${output}`);
			for (const line of output.split('\n')) {
				this.appendLogLine(run, `[stderr] ${line}`);
			}
		});

		processHandle.on('close', async (code) => {
			this.appendLogLine(run, `Exited with code: ${code}`);
			const success = code === 0;
			if (success) {
				await this.importLatestOutputs(run.file, run.contentType, run.startedAt);
				await this.writeRunLog(run, true);
				new Notice(`Paper2Slides finished for ${run.file.name}. Imported the latest outputs into ${targetDir}.`, 8000);
			} else {
				await this.writeRunLog(run, false);
				new Notice(`Paper2Slides failed for ${run.file.name}. Check ${path.posix.join(targetDir, 'last-run.log')}.`, 10000);
			}
			this.activeRun = null;
		});
	}

	async stopCurrentRun() {
		if (!this.activeRun) {
			new Notice('No Paper2Slides run is active right now.');
			return;
		}

		const run = this.activeRun;
		this.appendLogLine(run, 'Stopping run on user request.');
		run.process.kill('SIGTERM');
		setTimeout(() => {
			if (this.activeRun === run) {
				run.process.kill('SIGKILL');
			}
		}, 3000);
		new Notice(`Stopping Paper2Slides for ${run.file.name}...`);
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
			} else if (name.endsWith('.pdf') || name.endsWith('.png') || name.endsWith('.md')) {
				collected.push(currentPath);
			}
		}

		return collected;
	}

	private findLatestRunDir(modeDir: string): string | null {
		if (!fs.existsSync(modeDir)) {
			return null;
		}

		const matches: string[] = [];
		const walk = (dir: string) => {
			for (const name of fs.readdirSync(dir)) {
				const currentPath = path.join(dir, name);
				const stat = fs.statSync(currentPath);
				if (!stat.isDirectory()) {
					continue;
				}
				if (TIMESTAMP_DIR_PATTERN.test(name)) {
					matches.push(currentPath);
				}
				walk(currentPath);
			}
		};

		walk(modeDir);
		matches.sort((a, b) => {
			const nameCompare = path.basename(b).localeCompare(path.basename(a));
			if (nameCompare !== 0) {
				return nameCompare;
			}
			return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
		});
		return matches[0] ?? null;
	}

	private getModeDir(sourceFile: TFile, contentType: ContentType, fastMode = this.settings.fastMode): string {
		return path.join(
			this.settings.p2sPath.trim(),
			'outputs',
			sourceFile.basename,
			contentType,
			fastMode ? 'fast' : 'normal',
		);
	}

	private async writeVaultFile(vaultPath: string, sourcePath: string): Promise<void> {
		const data = fs.readFileSync(sourcePath);
		if (sourcePath.endsWith('.md') || sourcePath.endsWith('.log')) {
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

	private async writeRunLog(run: RunContext, success: boolean): Promise<void> {
		if (!this.settings.saveRunLog) {
			return;
		}

		await this.ensureVaultFolder(run.targetDir);
		const body = [
			...run.logLines,
			`Finished: ${new Date().toISOString()}`,
			`Status: ${success ? 'success' : 'failed'}`,
		].join('\n');

		await this.writeVaultFile(path.posix.join(run.targetDir, 'last-run.log'), this.createTempTextFile(body));
	}

	private createTempTextFile(content: string): string {
		const tempPath = path.join(this.app.vault.configDir, 'plugins', 'paper2slides-obsidian', 'tmp-last-run.log');
		fs.mkdirSync(path.dirname(tempPath), { recursive: true });
		fs.writeFileSync(tempPath, content, 'utf8');
		return tempPath;
	}

	async importLatestOutputs(sourceFile: TFile, contentType: ContentType, runStartedAt?: number) {
		const preferredModeDir = this.getModeDir(sourceFile, contentType, this.settings.fastMode);
		const fallbackModeDir = this.getModeDir(sourceFile, contentType, !this.settings.fastMode);
		let modeDir = preferredModeDir;
		let latestRunDir = this.findLatestRunDir(preferredModeDir);
		if (!latestRunDir) {
			modeDir = fallbackModeDir;
			latestRunDir = this.findLatestRunDir(fallbackModeDir);
		}
		const summaryPath = path.join(modeDir, 'summary.md');
		const targetDir = this.getTargetDir(sourceFile);

		const sourcePaths = new Set<string>();
		if (latestRunDir) {
			for (const filePath of this.collectGeneratedFiles(latestRunDir)) {
				if (!runStartedAt || fs.statSync(filePath).mtimeMs >= runStartedAt - 2000) {
					sourcePaths.add(filePath);
				}
			}
		}

		if (sourcePaths.size === 0 && latestRunDir) {
			for (const filePath of this.collectGeneratedFiles(latestRunDir)) {
				sourcePaths.add(filePath);
			}
		}

		if (fs.existsSync(summaryPath)) {
			sourcePaths.add(summaryPath);
		}

		if (sourcePaths.size === 0) {
			new Notice('Paper2Slides finished, but no output files were found to import.');
			return;
		}

		await this.ensureVaultFolder(targetDir);

		let importedCount = 0;
		for (const sourcePath of sourcePaths) {
			const fileName = path.basename(sourcePath);
			const vaultPath = path.posix.join(targetDir, fileName);
			await this.writeVaultFile(vaultPath, sourcePath);
			importedCount += 1;
		}

		new Notice(`Imported ${importedCount} files into ${targetDir}`, 7000);
	}

	async reimportLatestOutputs(file: TFile) {
		const setupOk = await this.runSetupCheck(false);
		if (!setupOk) {
			await this.runSetupCheck(true);
			return;
		}

		await this.importLatestOutputs(file, this.getContentType(file));
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
		containerEl.createEl('p', {
			text: 'You can trigger the plugin from the settings tab, the left ribbon, the command palette, or the file right-click menu.',
		});

		new Setting(containerEl)
			.setName('Run setup check')
			.setDesc('Verify Python, repo path, CLI startup, and paper2slides/.env.')
			.addButton((button) => button
				.setButtonText('Check now')
				.onClick(async () => {
					await this.plugin.runSetupCheck(true);
				}));

		new Setting(containerEl)
			.setName('Python command')
			.setDesc('Usually python3. Point this to your venv only if you actually need to.')
			.addText((text) => text
				.setPlaceholder('python3')
				.setValue(this.plugin.settings.pythonPath)
				.onChange(async (value) => {
					this.plugin.settings.pythonPath = value.trim() || 'python3';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Paper2Slides repo path')
			.setDesc('Absolute path to your local Paper2Slides checkout.')
			.addText((text) => text
				.setPlaceholder('/path/to/Paper2Slides')
				.setValue(this.plugin.settings.p2sPath)
				.onChange(async (value) => {
					this.plugin.settings.p2sPath = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Import folder in the vault')
			.setDesc('Imported files land here, grouped by source file name.')
			.addText((text) => text
				.setPlaceholder('Paper2Slides')
				.setValue(this.plugin.settings.importRoot)
				.onChange(async (value) => {
					this.plugin.settings.importRoot = value.trim() || 'Paper2Slides';
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
					this.display();
				}));

		if (this.plugin.settings.outputType === 'slides') {
			new Setting(containerEl)
				.setName('Slides length')
				.setDesc('Passed through to Paper2Slides as --length.')
				.addDropdown((dropdown) => dropdown
					.addOption('short', 'Short')
					.addOption('medium', 'Medium')
					.addOption('long', 'Long')
					.setValue(this.plugin.settings.slidesLength)
					.onChange(async (value: SlidesLength) => {
						this.plugin.settings.slidesLength = value;
						await this.plugin.saveSettings();
					}));
		} else {
			new Setting(containerEl)
				.setName('Poster density')
				.setDesc('Passed through to Paper2Slides as --density.')
				.addDropdown((dropdown) => dropdown
					.addOption('sparse', 'Sparse')
					.addOption('medium', 'Medium')
					.addOption('dense', 'Dense')
					.setValue(this.plugin.settings.posterDensity)
					.onChange(async (value: PosterDensity) => {
						this.plugin.settings.posterDensity = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Style preset')
			.setDesc('Use a built-in style or switch to custom and type your own prompt below.')
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
				.setDesc('Passed straight through as the style argument.')
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
			.setDesc('Skip RAG indexing. Better for quick passes and smaller inputs.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.fastMode)
				.onChange(async (value) => {
					this.plugin.settings.fastMode = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Parallel workers')
			.setDesc('Only used when set above 1.')
			.addText((text) => text
				.setPlaceholder('1')
				.setValue(String(this.plugin.settings.parallelWorkers))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					this.plugin.settings.parallelWorkers = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Save run log')
			.setDesc('Write last-run.log into the imported output folder.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.saveRunLog)
				.onChange(async (value) => {
					this.plugin.settings.saveRunLog = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Where to use it' });
		containerEl.createEl('p', {
			text: 'Use the ribbon button, command palette, or the right-click menu on a PDF or Markdown file. The plugin also exposes a re-import command and a stop command for long runs.',
		});
	}
}
