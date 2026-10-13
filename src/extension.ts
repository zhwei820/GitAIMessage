import * as vscode from 'vscode';
import * as path from 'node:path';
import {
	CommitMessageConfig,
	coreEnv,
	formatUsageAndCost,
	generateCommitMessage as generateMessage,
	getChanges,
	getUntrackedFiles,
	noChangesMessage,
	runGit,
} from './core';

const t = vscode.l10n.t;

function getConfig(): CommitMessageConfig {
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


// Minimal subset of the vscode.git extension API (see extensions/git/src/api/git.d.ts in VS Code).
type GitRepository = {
	rootUri: vscode.Uri;
	inputBox: vscode.SourceControlInputBox;
	ui?: { selected: boolean };
	status(): Promise<void>;
	push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
	state: {
		HEAD?: { name?: string; upstream?: { remote: string; name: string }; ahead?: number };
		remotes: { name: string }[];
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
async function resolveRepository(
	api: GitAPI,
	arg: unknown,
	placeHolder = t('Select a repository to generate a commit message for'),
): Promise<GitRepository | undefined> {
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
		{ placeHolder },
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

// Converts a remote URL (https, ssh://, or scp-like `git@host:owner/repo.git`) into the repository's web URL.
function remoteToWebUrl(remote: string): string | undefined {
	const scp = /^[^/@\s]+@([^:/\s]+):(?!\/)(.+)$/.exec(remote);
	let host: string;
	let repoPath: string;
	if (scp) {
		[, host, repoPath] = scp;
	} else {
		let url: URL;
		try {
			url = new URL(remote);
		} catch {
			return undefined;
		}
		if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) {
			return undefined;
		}
		// The ssh port is not the web port; keep an explicit port only for http(s).
		host = url.protocol.startsWith('http') ? url.host : url.hostname;
		repoPath = url.pathname;
	}
	repoPath = repoPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
	return repoPath ? `https://${host}/${repoPath}` : undefined;
}

// GitHub and Bitbucket are recognized by host name; anything else is assumed to be GitLab.
function branchWebUrl(repoUrl: string, branch: string): string {
	const host = new URL(repoUrl).hostname;
	const encoded = branch.split('/').map(encodeURIComponent).join('/');
	if (host.includes('github')) {
		return `${repoUrl}/tree/${encoded}`;
	}
	if (host.includes('bitbucket')) {
		return `${repoUrl}/src/${encoded}`;
	}
	return `${repoUrl}/-/tree/${encoded}`;
}

async function gitConfigValue(key: string, cwd: string): Promise<string | undefined> {
	try {
		return (await runGit(['config', '--get', key], cwd)).stdout.trim() || undefined;
	} catch {
		// `git config --get` exits with 1 when the key is unset.
		return undefined;
	}
}

// A branch without upstream is pushed as `git push --set-upstream <origin|only remote> <branch>` instead of
// vscode.git's publish prompt; otherwise delegate to git.push.
async function pushRepository(arg: unknown): Promise<void> {
	const repo = await resolveRepository(await getGitAPI(), arg, t('Select a repository to push'));
	if (!repo) {
		return;
	}
	const head = repo.state.HEAD;
	if (!head?.name || head.upstream) {
		await vscode.commands.executeCommand('git.push', repo.rootUri);
		return;
	}
	const remotes = repo.state.remotes.map((r) => r.name);
	const remote = remotes.includes('origin') ? 'origin' : remotes[0];
	if (!remote) {
		throw new Error(t('The repository has no remote.'));
	}
	await repo.push(remote, head.name, true);
}

// Uses the branch's upstream remote and upstream branch name when set, otherwise `origin` (or the only
// remote) and the local branch name.
async function openBranchInBrowser(arg: unknown): Promise<void> {
	const repo = await resolveRepository(await getGitAPI(), arg, t('Select a repository to open in the browser'));
	if (!repo) {
		return;
	}
	const gitRoot = repo.rootUri.fsPath;

	const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot)).stdout.trim();
	if (!branch || branch === 'HEAD') {
		throw new Error(t('HEAD is detached; there is no branch to open.'));
	}

	const remotes = (await runGit(['remote'], gitRoot)).stdout.split('\n').filter(Boolean);
	const upstreamRemote = await gitConfigValue(`branch.${branch}.remote`, gitRoot);
	const remote =
		(upstreamRemote && remotes.includes(upstreamRemote) && upstreamRemote) ||
		(remotes.includes('origin') ? 'origin' : remotes[0]);
	if (!remote) {
		throw new Error(t('The repository has no remote.'));
	}

	const remoteUrl = (await runGit(['remote', 'get-url', remote], gitRoot)).stdout.trim();
	const repoUrl = remoteToWebUrl(remoteUrl);
	if (!repoUrl) {
		throw new Error(t('Cannot derive a web URL from remote "{0}" ({1}).', remote, remoteUrl));
	}

	const upstreamRef = remote === upstreamRemote ? await gitConfigValue(`branch.${branch}.merge`, gitRoot) : undefined;
	const remoteBranch = upstreamRef?.replace(/^refs\/heads\//, '') || branch;
	await vscode.env.openExternal(vscode.Uri.parse(branchWebUrl(repoUrl, remoteBranch), true));
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

			const result = await generateMessage({ cfg, apiKey, changes, language: vscode.env.language });
			const commitMessage = result.message;

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
	coreEnv.t = t;
	coreEnv.gitExecutables = getGitExecutableCandidates;

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

	const push = async (arg?: unknown) => {
		try {
			await pushRepository(arg);
		} catch (err) {
			// vscode.git's GitError carries only "Failed to execute git" in message; git's reason is in stderr.
			const stderr = (err as { stderr?: unknown } | undefined)?.stderr;
			const detail = typeof stderr === 'string' ? stderr.trim() : '';
			const msg = detail || (err instanceof Error ? err.message : String(err));
			const showOutput = t('Show Git Output');
			if ((await vscode.window.showErrorMessage(msg, showOutput)) === showOutput) {
				await vscode.commands.executeCommand('git.showOutput');
			}
		}
	};
	context.subscriptions.push(
		vscode.commands.registerCommand('git-ai-message.push', push),
		vscode.commands.registerCommand('git-ai-message.pushUnpushed', push),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('git-ai-message.openBranchInBrowser', async (arg?: unknown) => {
			try {
				await openBranchInBrowser(arg);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(msg);
			}
		}),
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
