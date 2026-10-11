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

// Minimal subset of the vscode.git extension API (see extensions/git/src/api/git.d.ts in VS Code).
type GitRepository = {
	rootUri: vscode.Uri;
	inputBox: vscode.SourceControlInputBox;
	ui?: { selected: boolean };
	status(): Promise<void>;
	state: {
		HEAD?: { ahead?: number };
		onDidChange: vscode.Event<void>;
	};
};

type GitAPI = {
	state: 'uninitialized' | 'initialized';
	onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
	repositories: GitRepository[];
	onDidOpenRepository: vscode.Event<GitRepository>;
	onDidCloseRepository: vscode.Event<GitRepository>;
	getRepository(uri: vscode.Uri): GitRepository | null;
};

type GitExtension = {
	getAPI(version: 1): GitAPI;
};

async function getGitAPI(): Promise<GitAPI> {
	const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
	const api = gitExt ? (await gitExt.activate()).getAPI(1) : undefined;
	if (!api) {
		throw new Error(t('The built-in Git extension (vscode.git) is not available. Make sure it is enabled.'));
	}
	// Right after startup the API may not have discovered repositories yet.
	if (api.state !== 'initialized') {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(done, 5000);
			const sub = api.onDidChangeState((state) => state === 'initialized' && done());
			function done() {
				clearTimeout(timer);
				sub.dispose();
				resolve();
			}
		});
	}
	return api;
}

// Resolution order: the repository whose SCM title button was clicked (VS Code passes its SourceControl
// as the argument) → the only repository → the repository of the active editor → the single repository
// selected in the SCM view → ask the user. Returns undefined if the user dismisses the picker.
async function resolveRepository(api: GitAPI, arg: unknown): Promise<GitRepository | undefined> {
	const argRoot = (arg as { rootUri?: unknown } | undefined)?.rootUri;
	if (argRoot instanceof vscode.Uri) {
		const repo = api.getRepository(argRoot);
		if (repo) {
			return repo;
		}
	}

	const repos = api.repositories;
	if (repos.length === 0) {
		throw new Error(t('No Git repository found.'));
	}
	if (repos.length === 1) {
		return repos[0];
	}

	const activeUri = vscode.window.activeTextEditor?.document.uri;
	const fromEditor = activeUri ? api.getRepository(activeUri) : null;
	if (fromEditor) {
		return fromEditor;
	}

	const selected = repos.filter((r) => r.ui?.selected);
	if (selected.length === 1) {
		return selected[0];
	}

	const picked = await vscode.window.showQuickPick(
		repos.map((repo) => ({
			label: path.basename(repo.rootUri.fsPath),
			description: repo.rootUri.fsPath,
			repo,
		})),
		{ placeHolder: t('Select a repository to generate a commit message for') },
	);
	return picked?.repo;
}

// Publishes the roots of repositories with commits ahead of upstream as a context key, so the SCM title
// menu can swap in the highlighted push button via `scmProviderRootUri in gitAIMessage.unpushedRepos`.
// The values must match scmProviderRootUri, which VS Code sets to the SourceControl's rootUri.toString().
async function trackUnpushedCommits(context: vscode.ExtensionContext): Promise<void> {
	const api = await getGitAPI();
	const repoSubs = new Map<GitRepository, vscode.Disposable>();

	const update = () => {
		const roots = api.repositories.filter((r) => (r.state.HEAD?.ahead ?? 0) > 0).map((r) => r.rootUri.toString());
		void vscode.commands.executeCommand('setContext', 'gitAIMessage.unpushedRepos', roots);
	};
	const watch = (repo: GitRepository) => {
		repoSubs.set(repo, repo.state.onDidChange(update));
	};

	api.repositories.forEach(watch);
	context.subscriptions.push(
		api.onDidOpenRepository((repo) => {
			watch(repo);
			update();
		}),
		api.onDidCloseRepository((repo) => {
			repoSubs.get(repo)?.dispose();
			repoSubs.delete(repo);
			update();
		}),
		{ dispose: () => repoSubs.forEach((sub) => sub.dispose()) },
	);
	update();
}

// vscode.git's file watcher can miss changes (e.g. made by external tools), leaving the SCM view stale.
// Re-run `git status` periodically while the window is focused, and once whenever it regains focus.
async function autoRefreshRepositories(context: vscode.ExtensionContext): Promise<void> {
	const api = await getGitAPI();
	let running = false;
	const refresh = async () => {
		if (running || !vscode.window.state.focused) {
			return;
		}
		running = true;
		try {
			await Promise.all(api.repositories.map((r) => r.status().catch(() => undefined)));
		} finally {
			running = false;
		}
	};

	let timer: ReturnType<typeof setInterval> | undefined;
	const schedule = () => {
		clearInterval(timer);
		timer = undefined;
		const seconds = vscode.workspace.getConfiguration('gitAIMessage').get<number>('autoRefreshInterval', 5);
		if (seconds > 0) {
			timer = setInterval(() => void refresh(), Math.max(seconds, 1) * 1000);
		}
	};
	schedule();

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('gitAIMessage.autoRefreshInterval') && schedule()),
		vscode.window.onDidChangeWindowState((state) => state.focused && timer && void refresh()),
		{ dispose: () => clearInterval(timer) },
	);
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

// The model is asked for TARGET_MESSAGE_CHARS; MAX_MESSAGE_CHARS is enforced by truncation because
// models do not count characters reliably. Both are counted in Unicode code points.
const TARGET_MESSAGE_CHARS = 250;
const MAX_MESSAGE_CHARS = 300;

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
			`Exception: regardless of the format instruction, the entire commit message must be at most ${TARGET_MESSAGE_CHARS} characters.`,
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
			`The entire commit message must be at most ${TARGET_MESSAGE_CHARS} characters.`,
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

// Cuts at the last line break, else the last whitespace, within the limit; falls back to a hard cut
// (e.g. CJK text without spaces) when that boundary would drop more than the target/max gap.
function clampCommitMessage(text: string, maxChars: number): string {
	const chars = [...text];
	if (chars.length <= maxChars) {
		return text;
	}
	const head = chars.slice(0, maxChars).join('');
	const minKeep = head.length - (MAX_MESSAGE_CHARS - TARGET_MESSAGE_CHARS);
	for (const boundary of [head.lastIndexOf('\n'), head.search(/\s\S*$/)]) {
		if (boundary >= minKeep) {
			return head.slice(0, boundary).trimEnd();
		}
	}
	return head.trimEnd();
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

	// Chat Completions fallback.
	const chatContent = anyJson.choices?.[0]?.message?.content;
	if (typeof chatContent === 'string') {
		return chatContent.trim();
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

type RequestState = {
	api: 'responses' | 'chat';
	diffChars: number;
	temperature?: number;
	maxOutputTokens?: number;
};

type AttemptFailure = {
	message: string;
	// undefined: the request never got an HTTP response (network error, timeout).
	status?: number;
	retryAfterMs?: number;
	// 200 OK with no text because the token limit was hit (reasoning models can spend it all before answering).
	truncated?: boolean;
};

const MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRY_DELAY_MS = 20_000;
const MAX_OUTPUT_TOKENS_CEILING = 4096;
const MIN_DIFF_CHARS = 1000;

function buildRequestBody(model: string, system: string, user: string, s: RequestState): unknown {
	const temperature = s.temperature !== undefined ? { temperature: s.temperature } : {};
	if (s.api === 'chat') {
		return {
			model,
			...temperature,
			...(s.maxOutputTokens !== undefined ? { max_tokens: s.maxOutputTokens } : {}),
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
		};
	}
	// `store: false` requests no data retention by default (account/org policies may still apply).
	return {
		model,
		...temperature,
		...(s.maxOutputTokens !== undefined ? { max_output_tokens: s.maxOutputTokens } : {}),
		store: false,
		input: [
			{ role: 'system', content: [{ type: 'input_text', text: system }] },
			{ role: 'user', content: [{ type: 'input_text', text: user }] },
		],
	};
}

function isTruncatedResponse(json: any): boolean {
	return (
		(json?.status === 'incomplete' && json?.incomplete_details?.reason === 'max_output_tokens') ||
		json?.choices?.[0]?.finish_reason === 'length'
	);
}

function parseRetryAfterMs(value: string | null): number | undefined {
	if (!value) {
		return undefined;
	}
	const seconds = Number(value);
	if (Number.isFinite(seconds)) {
		return seconds * 1000;
	}
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

// Returns the next request to try, or null when retrying cannot help. Each fix is derived from the
// failure: drop a parameter the model rejects, shrink an oversized prompt, fall back to Chat
// Completions when the endpoint has no /responses, raise a token limit that cut the answer off, or
// back off on transient errors.
function planRetry(
	f: AttemptFailure,
	s: RequestState,
	attempt: number,
): { state: RequestState; delayMs: number; reason: string } | null {
	const msg = f.message.toLowerCase();

	if (f.truncated) {
		if (s.maxOutputTokens === undefined || s.maxOutputTokens >= MAX_OUTPUT_TOKENS_CEILING) {
			return null;
		}
		const maxOutputTokens = Math.min(s.maxOutputTokens * 4, MAX_OUTPUT_TOKENS_CEILING);
		return { state: { ...s, maxOutputTokens }, delayMs: 0, reason: `raise output token limit to ${maxOutputTokens}` };
	}

	if (f.status === 401 || f.status === 403 || msg.includes('quota')) {
		return null;
	}

	if (f.status === 400 || f.status === 422) {
		if (s.temperature !== undefined && msg.includes('temperature')) {
			return { state: { ...s, temperature: undefined }, delayMs: 0, reason: 'drop temperature' };
		}
		if (s.maxOutputTokens !== undefined && /max_(output_|completion_)?tokens/.test(msg)) {
			return { state: { ...s, maxOutputTokens: undefined }, delayMs: 0, reason: 'drop output token limit' };
		}
	}

	if (f.status === 413 || /context|too long|too large|too many tokens|maximum.*tokens/.test(msg)) {
		if (s.diffChars <= MIN_DIFF_CHARS) {
			return null;
		}
		const diffChars = Math.max(MIN_DIFF_CHARS, Math.floor(s.diffChars / 2));
		return { state: { ...s, diffChars }, delayMs: 0, reason: `shrink diff to ${diffChars} chars` };
	}

	if (s.api === 'responses' && (f.status === 404 || f.status === 405 || f.status === 501)) {
		return { state: { ...s, api: 'chat' }, delayMs: 0, reason: 'fall back to /chat/completions' };
	}

	if (f.status === undefined || f.status === 408 || f.status === 409 || f.status === 429 || f.status >= 500) {
		const backoff = 1000 * 2 ** (attempt - 1);
		const delayMs = Math.min(f.retryAfterMs ?? backoff, MAX_RETRY_DELAY_MS);
		return { state: s, delayMs, reason: `transient error, retry in ${delayMs} ms` };
	}

	return null;
}

async function callOpenAIResponses(params: {
	apiBaseUrl: string;
	apiKey: string | null;
	model: string;
	system: string;
	buildUser: (diffChars: number) => string;
	diffChars: number;
	temperature: number;
	maxOutputTokens: number;
}): Promise<{ text: string; usage?: OpenAIUsage }> {
	const fetchFn = (globalThis as any).fetch as undefined | ((input: any, init?: any) => Promise<any>);
	if (!fetchFn) {
		throw new Error(t('fetch is not available in this extension host environment.'));
	}

	const baseUrl = params.apiBaseUrl.replace(/\/+$/, '');
	let state: RequestState = {
		api: 'responses',
		diffChars: params.diffChars,
		temperature: params.temperature,
		maxOutputTokens: params.maxOutputTokens,
	};

	for (let attempt = 1; ; attempt++) {
		const url = `${baseUrl}/${state.api === 'chat' ? 'chat/completions' : 'responses'}`;
		const body = buildRequestBody(params.model, params.system, params.buildUser(state.diffChars), state);

		let failure: AttemptFailure;
		try {
			const res = await fetchFn(url, {
				method: 'POST',
				headers: {
					...(params.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : {}),
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});

			const text = await res.text();
			let json: unknown = undefined;
			try {
				json = JSON.parse(text);
			} catch {
				// If the response isn't JSON, we still surface a best-effort error message below.
			}

			if (res.ok) {
				const outputText = extractOutputText(json);
				if (outputText) {
					return { text: outputText, usage: extractUsage(json) };
				}
				failure = {
					message: t('Could not extract a commit message from OpenAI API response.'),
					status: res.status,
					truncated: isTruncatedResponse(json),
				};
			} else {
				failure = {
					message:
						(json as any)?.error?.message ||
						(typeof text === 'string' && text.trim() ? text.trim() : `HTTP ${res.status}`),
					status: res.status,
					retryAfterMs: parseRetryAfterMs(res.headers?.get?.('retry-after') ?? null),
				};
			}
		} catch (err) {
			const e = err as Error & { cause?: { message?: string } };
			failure = { message: e.cause?.message ? `${e.message} (${e.cause.message})` : String(e.message ?? err) };
		}

		const next = attempt < MAX_ATTEMPTS ? planRetry(failure, state, attempt) : null;
		if (!next) {
			if (failure.status !== undefined && failure.status < 300) {
				throw new Error(failure.message);
			}
			throw new Error(t('OpenAI API error: {0}', failure.message));
		}
		console.warn(`[git-ai-message] attempt ${attempt} failed (${failure.status ?? 'network'}: ${failure.message}); ${next.reason}`);
		if (next.delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, next.delayMs));
		}
		state = next.state;
	}
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

async function generateCommitMessage(context: vscode.ExtensionContext, arg: unknown): Promise<void> {
	const cfg = getConfig();
	const repo = await resolveRepository(await getGitAPI(), arg);
	if (!repo) {
		return;
	}
	const gitRoot = repo.rootUri.fsPath;

	// Optional: local proxies such as cc-ds.py accept requests without a key.
	const apiKey = await getApiKey(context);

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: t('Generating commit message…'),
			cancellable: false,
		},
		async () => {
			const changes = await getChanges(gitRoot);
			if (!changes) {
				vscode.window.showWarningMessage(noChangesMessage(await getUntrackedFiles(gitRoot)));
				return;
			}

			const prompt = (diffChars: number) =>
				buildPrompt({
					additionalInstructions: cfg.additionalInstructions,
					formatInstruction: cfg.formatInstruction,
					source: changes.source,
					summary: changes.summary,
					diff: truncateWithNotice(changes.diff, diffChars),
				});

			const result = await callOpenAIResponses({
				apiBaseUrl: cfg.apiBaseUrl,
				apiKey,
				model: cfg.model,
				system: prompt(cfg.maxDiffChars).system,
				buildUser: (diffChars) => prompt(diffChars).user,
				diffChars: Math.min(cfg.maxDiffChars, changes.diff.length),
				temperature: cfg.temperature,
				maxOutputTokens: cfg.maxOutputTokens,
			});

			const commitMessage = clampCommitMessage(sanitizeCommitMessage(result.text), MAX_MESSAGE_CHARS);
			if (!commitMessage) {
				vscode.window.showErrorMessage(t('Generated commit message is empty.'));
				return;
			}

			repo.inputBox.value = commitMessage;

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
		vscode.commands.registerCommand('git-ai-message.generateFromStaged', async (arg?: unknown) => {
			try {
				await generateCommitMessage(context, arg);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(msg);
			}
		}),
	);

	// Forward the clicked SCM provider so vscode.git pushes that repository (or prompts when absent).
	const push = async (arg?: unknown) => {
		try {
			await vscode.commands.executeCommand('git.push', arg);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(msg);
		}
	};
	context.subscriptions.push(
		vscode.commands.registerCommand('git-ai-message.push', push),
		vscode.commands.registerCommand('git-ai-message.pushUnpushed', push),
	);

	trackUnpushedCommits(context).catch((err) => console.error('[git-ai-message] tracking unpushed commits failed:', err));
	autoRefreshRepositories(context).catch((err) => console.error('[git-ai-message] auto refresh setup failed:', err));

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
