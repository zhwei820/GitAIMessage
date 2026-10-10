import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const t = vscode.l10n.t;

type ExtensionConfig = {
	apiBaseUrl: string;
	model: string;
	additionalInstructions: string;
	formatInstruction: string;
	maxDiffChars: number;
	temperature: number;
	maxOutputTokens: number;
	showUsageInNotification: boolean;
	currency: string;
	priceInputPer1M: number;
	priceOutputPer1M: number;
};

function getConfig(): ExtensionConfig {
	const cfg = vscode.workspace.getConfiguration('gitAIMessage');
	const legacyCfg = vscode.workspace.getConfiguration('gitGenComment');
	const legacyCfg2 = vscode.workspace.getConfiguration('genCommitLog');

	const getValue = <T>(key: string, defaultValue: T): T => {
		// Prefer the new namespace, but only if the user actually set a value.
		// Using `inspect()` avoids treating the contributed default value as "user config",
		// which lets us fall back to legacy namespaces when needed for migrations.
		const inspectedNew = cfg.inspect<T>(key);
		const newUserSet =
			inspectedNew?.workspaceValue !== undefined ||
			inspectedNew?.workspaceFolderValue !== undefined ||
			inspectedNew?.globalValue !== undefined;
		if (newUserSet) {
			return cfg.get<T>(key, defaultValue);
		}

		const inspectedLegacy1 = legacyCfg.inspect<T>(key);
		const legacy1UserSet =
			inspectedLegacy1?.workspaceValue !== undefined ||
			inspectedLegacy1?.workspaceFolderValue !== undefined ||
			inspectedLegacy1?.globalValue !== undefined;
		if (legacy1UserSet) {
			return legacyCfg.get<T>(key, defaultValue);
		}

		const inspectedLegacy2 = legacyCfg2.inspect<T>(key);
		const legacy2UserSet =
			inspectedLegacy2?.workspaceValue !== undefined ||
			inspectedLegacy2?.workspaceFolderValue !== undefined ||
			inspectedLegacy2?.globalValue !== undefined;
		if (legacy2UserSet) {
			return legacyCfg2.get<T>(key, defaultValue);
		}

		// If nothing is set, use the new key's default (which can be localized via package.nls*).
		return cfg.get<T>(key, defaultValue);
	};

	return {
		apiBaseUrl: getValue<string>('apiBaseUrl', 'http://127.0.0.1:8000'),
		model: getValue<string>('model', 'gpt-5.1'),
		additionalInstructions: getValue<string>('additionalInstructions', ''),
		formatInstruction: getValue<string>('formatInstruction', ''),
		maxDiffChars: getValue<number>('maxDiffChars', 12000),
		temperature: getValue<number>('temperature', 0.2),
		maxOutputTokens: getValue<number>('maxOutputTokens', 200),
		showUsageInNotification: getValue<boolean>('showUsageInNotification', true),
		currency: getValue<string>('currency', 'USD'),
		priceInputPer1M: getValue<number>('priceInputPer1M', 0),
		priceOutputPer1M: getValue<number>('priceOutputPer1M', 0),
	};
}

function getGitExecutableCandidates(): string[] {
	const gitConfig = vscode.workspace.getConfiguration('git');
	const configured = gitConfig.get<string | string[]>('path');
	const normalizeCandidate = (value: string) => value.trim().replace(/^"(.*)"$/, '$1');
	const candidates: string[] = [];

	if (Array.isArray(configured)) {
		for (const value of configured) {
			if (typeof value === 'string' && value.trim()) {
				candidates.push(normalizeCandidate(value));
			}
		}
	} else if (typeof configured === 'string' && configured.trim()) {
		candidates.push(normalizeCandidate(configured));
	}

	candidates.push('git');

	const seen = new Set<string>();
	const unique: string[] = [];
	for (const candidate of candidates) {
		const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
		if (!seen.has(key)) {
			seen.add(key);
			unique.push(candidate);
		}
	}

	return unique;
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	// Increase buffer because diffs can be large.
	const candidates = getGitExecutableCandidates();
	let lastErr: unknown;

	for (const gitExecutable of candidates) {
		try {
			const { stdout, stderr } = await execFileAsync(gitExecutable, args, {
				cwd,
				maxBuffer: 10 * 1024 * 1024,
			});
			return { stdout: stdout.toString(), stderr: stderr.toString() };
		} catch (err) {
			const anyErr = err as NodeJS.ErrnoException | undefined;
			if (anyErr?.code === 'ENOENT') {
				lastErr = err;
				continue;
			}
			throw err;
		}
	}

	if ((lastErr as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
		// The `git` executable is not available (not installed, not in PATH, etc.).
		// Surface a clear, localized message instead of a raw Node.js spawn error.
		throw new Error(
			t('Git CLI not found. Install Git or make sure the `git` command is available in PATH.'),
		);
	}

	throw lastErr;
}

async function getGitRoot(workspacePath: string): Promise<string> {
	const { stdout } = await runGit(['rev-parse', '--show-toplevel'], workspacePath);
	return stdout.trim();
}

type ChangeSet = { source: 'staged' | 'unstaged'; summary: string; diff: string };

// Prefer staged changes; when nothing is staged, fall back to unstaged changes to tracked files
// (untracked files are not included).
async function getChanges(gitRoot: string): Promise<ChangeSet | null> {
	for (const source of ['staged', 'unstaged'] as const) {
		const base = source === 'staged' ? ['diff', '--cached', '--no-color'] : ['diff', '--no-color'];
		const { stdout: diff } = await runGit(base, gitRoot);
		if (diff.trim()) {
			const { stdout: summary } = await runGit([...base, '--stat'], gitRoot);
			return { source, summary: summary.trim(), diff };
		}
	}
	return null;
}

async function getUntrackedFiles(gitRoot: string): Promise<string[]> {
	const { stdout } = await runGit(['ls-files', '--others', '--exclude-standard'], gitRoot);
	return stdout.split('\n').filter(Boolean);
}

function noChangesMessage(untracked: string[]): string {
	if (untracked.length === 0) {
		return t('No changes found: nothing is staged and tracked files are unchanged.');
	}
	const shown = untracked.slice(0, 3).join(', ') + (untracked.length > 3 ? ', …' : '');
	return t(
		'No changes found in tracked files. {0} untracked file(s) ({1}) are not included; stage them with `git add` first.',
		untracked.length,
		shown,
	);
}

type GitExtension = {
	getAPI: (version: number) => { repositories: Array<any> };
};

function normalizeFsPath(p: string): string {
	const resolved = path.resolve(p);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function setGitScmInputBoxValue(gitRoot: string, value: string): Promise<boolean> {
	const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!gitExt) {
		return false;
	}

	try {
		await gitExt.activate();
	} catch {
		// If activation fails, we fall back to best-effort behavior and let the caller show an error.
	}

	const api = (gitExt.exports as any)?.getAPI?.(1);
	const repos = api?.repositories;
	if (!Array.isArray(repos) || repos.length === 0) {
		return false;
	}

	const root = normalizeFsPath(gitRoot);
	// Select the repository matching the workspace's git root. If not found, fall back to the first repo
	// because VS Code can host multiple repositories in a single workspace.
	const repo =
		repos.find((r: any) => r?.rootUri?.fsPath && normalizeFsPath(r.rootUri.fsPath) === root) ?? repos[0];

	const inputBox =
		(repo?.inputBox as vscode.SourceControlInputBox | undefined) ??
		(repo?.sourceControl?.inputBox as vscode.SourceControlInputBox | undefined);

	if (!inputBox) {
		return false;
	}

	inputBox.value = value;
	return true;
}

function truncateWithNotice(text: string, maxChars: number): string {
	if (maxChars <= 0) {
		return '';
	}
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}\n\n[...truncated to ${maxChars} chars...]`;
}

function buildPrompt(params: {
	additionalInstructions: string;
	formatInstruction: string;
	source: ChangeSet['source'];
	summary: string;
	diff: string;
}): { system: string; user: string } {
	const lang = vscode.env.language.toLowerCase().startsWith('ja') ? 'Japanese' : 'English';

	const format = params.formatInstruction.trim() ? params.formatInstruction.trim() : '';
	const extra = params.additionalInstructions.trim() ? params.additionalInstructions.trim() : '';

	const hasFormatInstruction = format.length > 0;
	// If a format instruction is provided, we treat it as the highest priority and avoid prescribing
	// additional structure (like "subject only") that could conflict with the requested format.
	const system = hasFormatInstruction
		? [
			`You generate a Git commit message from ${params.source} changes.`,
			'Follow the output format instruction EXACTLY. If it conflicts with other guidelines, the output format instruction wins.',
			`Write in ${lang} unless the output format instruction specifies otherwise.`,
			format,
			'Do not include code fences. Do not wrap in quotes.',
			'Output ONLY the commit message text.',
		].join('\n')
		: [
			`You generate a Git commit message from ${params.source} changes.`,
			`Write in ${lang}.`,
			'Output only a single-line subject (no body).',
			'Subject should be concise (ideally <= 72 characters).',
			'Do not include code fences. Do not wrap in quotes.',
			'Output ONLY the commit message text.',
		].join('\n');

	const label = params.source === 'staged' ? 'Staged' : 'Unstaged';
	const user = [
		extra,
		`${label} summary:`,
		params.summary || '(no --stat output)',
		'',
		`${label} diff:`,
		params.diff || '(empty diff)',
	]
		.filter(Boolean)
		.join('\n');

	return {
		system,
		user,
	};
}

function sanitizeCommitMessage(text: string): string {
	let out = text.trim();
	out = out.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```$/m, '').trim();
	out = out.replace(/^["'“”‘’]\s*/g, '').replace(/\s*["'“”‘’]$/g, '').trim();
	return out;
}

type OpenAIUsage = {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
};

function isNumber(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v);
}

function extractOutputText(responseJson: unknown): string {
	if (!responseJson || typeof responseJson !== 'object') {
		return '';
	}
	const anyJson = responseJson as any;

	// Responses API convenience field.
	if (typeof anyJson.output_text === 'string') {
		return anyJson.output_text;
	}

	// Responses API structured output: concatenate all output_text parts.
	const output = anyJson.output;
	if (!Array.isArray(output)) {
		return '';
	}

	const parts: string[] = [];
	for (const item of output) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const content = (item as any).content;
		if (!Array.isArray(content)) {
			continue;
		}
		for (const c of content) {
			if (!c || typeof c !== 'object') {
				continue;
			}
			if ((c as any).type === 'output_text' && typeof (c as any).text === 'string') {
				parts.push((c as any).text);
			}
		}
	}
	return parts.join('').trim();
}

function extractUsage(responseJson: unknown): OpenAIUsage | undefined {
	if (!responseJson || typeof responseJson !== 'object') {
		return undefined;
	}
	const anyJson = responseJson as any;
	const usage = anyJson.usage;
	if (!usage || typeof usage !== 'object') {
		return undefined;
	}

	// Prefer Responses API token fields when available.
	const inputTokens = isNumber(usage.input_tokens) ? usage.input_tokens : undefined;
	const outputTokens = isNumber(usage.output_tokens) ? usage.output_tokens : undefined;
	const totalTokens = isNumber(usage.total_tokens) ? usage.total_tokens : undefined;

	// Backward-compatible fields (some proxies/gateways still use Chat Completions naming).
	const promptTokens = isNumber(usage.prompt_tokens) ? usage.prompt_tokens : undefined;
	const completionTokens = isNumber(usage.completion_tokens) ? usage.completion_tokens : undefined;

	return {
		inputTokens: inputTokens ?? promptTokens,
		outputTokens: outputTokens ?? completionTokens,
		totalTokens,
	};
}

async function callOpenAIResponses(params: {
	apiBaseUrl: string;
	apiKey: string | null;
	model: string;
	system: string;
	user: string;
	temperature: number;
	maxOutputTokens: number;
}): Promise<{ text: string; usage?: OpenAIUsage }> {
	const fetchFn = (globalThis as any).fetch as undefined | ((input: any, init?: any) => Promise<any>);
	if (!fetchFn) {
		throw new Error(t('fetch is not available in this extension host environment.'));
	}

	// Use OpenAI Responses API. `store: false` requests no data retention by default (account/org policies may still apply).
	const url = `${params.apiBaseUrl.replace(/\/+$/, '')}/responses`;
	const body = {
		model: params.model,
		temperature: params.temperature,
		max_output_tokens: params.maxOutputTokens,
		store: false,
		input: [
			{
				role: 'system',
				content: [{ type: 'input_text', text: params.system }],
			},
			{
				role: 'user',
				content: [{ type: 'input_text', text: params.user }],
			},
		],
	};

	const res = await fetchFn(url, {
		method: 'POST',
		headers: {
			...(params.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : {}),
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});

	const text = await res.text();
	let json: unknown = undefined;
	try {
		json = JSON.parse(text);
	} catch {
		// If the response isn't JSON, we still surface a best-effort error message below.
	}

	if (!res.ok) {
		const msg =
			(json as any)?.error?.message ||
			(typeof text === 'string' && text.trim() ? text.trim() : `HTTP ${res.status}`);
		throw new Error(t('OpenAI API error: {0}', msg));
	}

	const outputText = extractOutputText(json);
	if (!outputText) {
		throw new Error(t('Could not extract a commit message from OpenAI API response.'));
	}

	return {
		text: outputText,
		usage: extractUsage(json),
	};
}

async function getApiKey(context: vscode.ExtensionContext): Promise<string | null> {
	const newKey = 'gitAIMessage.openaiApiKey';
	const oldKey1 = 'gitGenComment.openaiApiKey';
	const oldKey2 = 'genCommitLog.openaiApiKey';

	// Read from the current key first, then migrate from legacy keys if present.
	const fromNew = await context.secrets.get(newKey);
	if (fromNew?.trim()) {
		return fromNew.trim();
	}

	const fromOld1 = await context.secrets.get(oldKey1);
	if (fromOld1?.trim()) {
		// Automatic migration from legacy key.
		await context.secrets.store(newKey, fromOld1.trim());
		await context.secrets.delete(oldKey1);
		return fromOld1.trim();
	}

	const fromOld2 = await context.secrets.get(oldKey2);
	if (fromOld2?.trim()) {
		await context.secrets.store(newKey, fromOld2.trim());
		await context.secrets.delete(oldKey2);
		return fromOld2.trim();
	}

	return null;
}

function formatUsageAndCost(cfg: ExtensionConfig, usage?: OpenAIUsage): string | null {
	if (!cfg.showUsageInNotification || !usage) {
		return null;
	}

	const parts: string[] = [];
	if (isNumber(usage.inputTokens) || isNumber(usage.outputTokens) || isNumber(usage.totalTokens)) {
		const inStr = isNumber(usage.inputTokens) ? usage.inputTokens.toLocaleString() : '?';
		const outStr = isNumber(usage.outputTokens) ? usage.outputTokens.toLocaleString() : '?';
		const totalStr = isNumber(usage.totalTokens) ? usage.totalTokens.toLocaleString() : '?';
		parts.push(t('tokens: in {0} / out {1} (total {2})', inStr, outStr, totalStr));
	}

	if (cfg.priceInputPer1M > 0 && cfg.priceOutputPer1M > 0) {
		const inputTokens = usage.inputTokens;
		const outputTokens = usage.outputTokens;
		if (!isNumber(inputTokens) || !isNumber(outputTokens)) {
			parts.push(t('estimated cost: (usage not available)'));
			return parts.join(' / ');
		}

		const cost =
			(inputTokens / 1_000_000) * cfg.priceInputPer1M +
			(outputTokens / 1_000_000) * cfg.priceOutputPer1M;
		if (cost > 0 && cost < 0.001) {
			parts.push(t('estimated cost: {0} <0.001', cfg.currency));
		} else {
			const formatted = cost.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
			parts.push(t('estimated cost: {0} {1}', cfg.currency, formatted));
		}
	}

	return parts.length ? parts.join(' / ') : null;
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
	const apiKey = await vscode.window.showInputBox({
		title: t('Git AI Message: Set OpenAI API Key'),
		prompt: t('Enter your OpenAI API Key (stored in Secret Storage).'),
		password: true,
		ignoreFocusOut: true,
	});
	if (apiKey === undefined) {
		return;
	}
	if (!apiKey.trim()) {
		vscode.window.showWarningMessage(t('API key is empty. Nothing was saved.'));
		return;
	}
	await context.secrets.store('gitAIMessage.openaiApiKey', apiKey.trim());
	vscode.window.showInformationMessage(t('OpenAI API Key saved.'));
}

async function deleteApiKey(context: vscode.ExtensionContext): Promise<void> {
	const existing = await context.secrets.get('gitAIMessage.openaiApiKey');
	if (!existing) {
		vscode.window.showInformationMessage(t('No saved OpenAI API Key.'));
		return;
	}

	const deleteAction = t('Delete');
	const action = await vscode.window.showWarningMessage(
		t('Delete the saved OpenAI API Key?'),
		{ modal: true },
		deleteAction,
	);
	if (action !== deleteAction) {
		return;
	}

	await context.secrets.delete('gitAIMessage.openaiApiKey');
	vscode.window.showInformationMessage(t('OpenAI API Key deleted.'));
}

async function generateCommitMessageFromStaged(context: vscode.ExtensionContext): Promise<void> {
	const cfg = getConfig();
	const workspaceFolder =
		(vscode.window.activeTextEditor?.document.uri
			? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
			: undefined) ?? vscode.workspace.workspaceFolders?.[0];

	if (!workspaceFolder) {
		vscode.window.showErrorMessage(t('No workspace folder found.'));
		return;
	}

	// Optional: local proxies such as cc-ds.py accept requests without a key.
	const apiKey = await getApiKey(context);

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: t('Generating commit message…'),
			cancellable: false,
		},
		async () => {
			const gitRoot = await getGitRoot(workspaceFolder.uri.fsPath);
			const changes = await getChanges(gitRoot);
			if (!changes) {
				vscode.window.showWarningMessage(noChangesMessage(await getUntrackedFiles(gitRoot)));
				return;
			}

			const { system, user } = buildPrompt({
				additionalInstructions: cfg.additionalInstructions,
				formatInstruction: cfg.formatInstruction,
				source: changes.source,
				summary: changes.summary,
				diff: truncateWithNotice(changes.diff, cfg.maxDiffChars),
			});

			const result = await callOpenAIResponses({
				apiBaseUrl: cfg.apiBaseUrl,
				apiKey,
				model: cfg.model,
				system,
				user,
				temperature: cfg.temperature,
				maxOutputTokens: cfg.maxOutputTokens,
			});

			const commitMessage = sanitizeCommitMessage(result.text);
			if (!commitMessage) {
				vscode.window.showErrorMessage(t('Generated commit message is empty.'));
				return;
			}

			const applied = await setGitScmInputBoxValue(gitRoot, commitMessage);
			if (!applied) {
				vscode.window.showErrorMessage(
					t(
						'Could not apply the commit message to Git commit input. Make sure the built-in Git extension (vscode.git) is enabled.',
					),
				);
				return;
			}

			await vscode.commands.executeCommand('workbench.view.scm');
			try {
				await vscode.commands.executeCommand('workbench.scm.action.focusInput');
			} catch {
				// This command isn't available in all VS Code builds; failing to focus is non-fatal.
			}
			const usageText = formatUsageAndCost(cfg, result.usage);
			vscode.window.showInformationMessage(
				usageText
					? t('Commit message generated ({0}).', usageText)
					: t('Commit message generated.'),
			);
		},
	);
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('git-ai-message.generateFromStaged', async () => {
			try {
				await generateCommitMessageFromStaged(context);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(msg);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('git-ai-message.setOpenAIApiKey', async () => {
			try {
				await setApiKey(context);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(msg);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('git-ai-message.deleteOpenAIApiKey', async () => {
			try {
				await deleteApiKey(context);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(msg);
			}
		}),
	);
}

export function deactivate() { }
