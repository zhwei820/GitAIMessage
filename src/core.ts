// Shared by the VS Code extension and the CLI; must not import 'vscode'.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type Translate = (message: string, ...args: (string | number)[]) => string;

// The extension swaps in vscode.l10n.t and git.path candidates; the CLI keeps the defaults.
export const coreEnv: { t: Translate; gitExecutables: () => string[] } = {
	t: (message, ...args) => message.replace(/\{(\d+)\}/g, (m, i: string) => (args[+i] !== undefined ? String(args[+i]) : m)),
	gitExecutables: () => ['git'],
};

const t: Translate = (message, ...args) => coreEnv.t(message, ...args);

export type CommitMessageConfig = {
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

export async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	// Increase buffer because diffs can be large.
	const candidates = coreEnv.gitExecutables();
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

// uncommitted: staged + unstaged changes to tracked files, i.e. what `git commit -a` records.
export type ChangeSet = { source: 'staged' | 'unstaged' | 'uncommitted'; summary: string; diff: string };

// Returns the first non-empty source in order; by default staged, then unstaged changes to tracked files
// (untracked files are never included).
export async function getChanges(
	gitRoot: string,
	sources: readonly ChangeSet['source'][] = ['staged', 'unstaged'],
): Promise<ChangeSet | null> {
	for (const source of sources) {
		const base = { staged: ['diff', '--cached', '--no-color'], unstaged: ['diff', '--no-color'], uncommitted: ['diff', 'HEAD', '--no-color'] }[source];
		const { stdout: diff } = await runGit(base, gitRoot);
		if (diff.trim()) {
			const { stdout: summary } = await runGit([...base, '--stat'], gitRoot);
			return { source, summary: summary.trim(), diff };
		}
	}
	return null;
}

export async function getUntrackedFiles(gitRoot: string): Promise<string[]> {
	const { stdout } = await runGit(['ls-files', '--others', '--exclude-standard'], gitRoot);
	return stdout.split('\n').filter(Boolean);
}

export function noChangesMessage(untracked: string[]): string {
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
	language: string;
	additionalInstructions: string;
	formatInstruction: string;
	source: ChangeSet['source'];
	summary: string;
	diff: string;
}): { system: string; user: string } {
	const lang = params.language.toLowerCase().startsWith('ja') ? 'Japanese' : 'English';

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

	const label = params.source[0].toUpperCase() + params.source.slice(1);
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

export type OpenAIUsage = {
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

export function formatUsageAndCost(cfg: CommitMessageConfig, usage?: OpenAIUsage): string | null {
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
// `language` is a locale such as "ja" or "en-US"; Japanese is used when it starts with "ja", otherwise English.
export async function generateCommitMessage(params: {
	cfg: CommitMessageConfig;
	apiKey: string | null;
	changes: ChangeSet;
	language: string;
}): Promise<{ message: string; usage?: OpenAIUsage }> {
	const { cfg, changes } = params;
	const prompt = (diffChars: number) =>
		buildPrompt({
			language: params.language,
			additionalInstructions: cfg.additionalInstructions,
			formatInstruction: cfg.formatInstruction,
			source: changes.source,
			summary: changes.summary,
			diff: truncateWithNotice(changes.diff, diffChars),
		});

	const result = await callOpenAIResponses({
		apiBaseUrl: cfg.apiBaseUrl,
		apiKey: params.apiKey,
		model: cfg.model,
		system: prompt(cfg.maxDiffChars).system,
		buildUser: (diffChars) => prompt(diffChars).user,
		diffChars: Math.min(cfg.maxDiffChars, changes.diff.length),
		temperature: cfg.temperature,
		maxOutputTokens: cfg.maxOutputTokens,
	});

	const message = clampCommitMessage(sanitizeCommitMessage(result.text), MAX_MESSAGE_CHARS);
	if (!message) {
		throw new Error(t('Generated commit message is empty.'));
	}
	return { message, usage: result.usage };
}
