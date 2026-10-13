import { spawnSync } from 'node:child_process';
import {
	ChangeSet,
	CommitMessageConfig,
	formatUsageAndCost,
	generateCommitMessage,
	getChanges,
	getUntrackedFiles,
	noChangesMessage,
	runGit,
} from './core';

const HELP = `Usage: aicommit [-a] [-m] [--print] [git commit options...]

Generates a commit message with AI from the changes to be committed, then runs git commit.

  -a, --all   Commit all changes to tracked files (like git commit -a)
  -m          Commit with the generated message directly (without -m, the editor opens pre-filled)
  --print     Print the generated message only; do not commit
  -h, --help  Show this help

Other options are passed through to git commit (e.g. -s, --no-verify).
Examples: aicommit -am   aicommit -a   aicommit -m -s

Configuration (git config, --global or per repository; same names as the VS Code settings):
  gitAIMessage.apiBaseUrl, gitAIMessage.model, gitAIMessage.additionalInstructions,
  gitAIMessage.formatInstruction, gitAIMessage.maxDiffChars, gitAIMessage.temperature,
  gitAIMessage.maxOutputTokens, gitAIMessage.language (default: from LANG)
API key: $GIT_AI_MESSAGE_API_KEY, $OPENAI_API_KEY, or git config gitAIMessage.apiKey (optional for a local proxy)
`;

type Options = { all: boolean; direct: boolean; print: boolean; passthrough: string[] };

function parseArgs(argv: string[]): Options | 'help' {
	const opts: Options = { all: false, direct: false, print: false, passthrough: [] };
	for (const arg of argv) {
		if (arg === '-h' || arg === '--help') {
			return 'help';
		} else if (arg === '--all') {
			opts.all = true;
		} else if (arg === '--print') {
			opts.print = true;
		} else if (/^-[am]+$/.test(arg)) {
			opts.all ||= arg.includes('a');
			opts.direct ||= arg.includes('m');
		} else {
			opts.passthrough.push(arg);
		}
	}
	return opts;
}

// git config keys are case-insensitive and `--get-regexp` reports them lowercased.
async function readGitConfig(cwd: string): Promise<Map<string, string>> {
	const values = new Map<string, string>();
	try {
		const { stdout } = await runGit(['config', '-z', '--get-regexp', '^gitaimessage\\.'], cwd);
		for (const entry of stdout.split('\0').filter(Boolean)) {
			const nl = entry.indexOf('\n');
			values.set(entry.slice('gitaimessage.'.length, nl < 0 ? undefined : nl), nl < 0 ? '' : entry.slice(nl + 1));
		}
	} catch {
		// Exits with 1 when no key matches.
	}
	return values;
}

function buildConfig(git: Map<string, string>): CommitMessageConfig {
	const str = (key: string, def: string) => git.get(key.toLowerCase()) ?? def;
	const num = (key: string, def: number) => {
		const v = Number(git.get(key.toLowerCase()));
		return git.has(key.toLowerCase()) && Number.isFinite(v) ? v : def;
	};
	// Defaults mirror the extension's (package.json / package.nls.json).
	return {
		apiBaseUrl: str('apiBaseUrl', 'http://127.0.0.1:8000'),
		model: str('model', 'gpt-5.1'),
		additionalInstructions: str('additionalInstructions', 'Understand the essence of the changes.'),
		formatInstruction: str('formatInstruction', "Output each change as a concise list prefixed with '- '."),
		maxDiffChars: num('maxDiffChars', 12000),
		temperature: num('temperature', 0.2),
		maxOutputTokens: num('maxOutputTokens', 200),
		showUsageInNotification: true,
		currency: str('currency', 'USD'),
		priceInputPer1M: num('priceInputPer1M', 0),
		priceOutputPer1M: num('priceOutputPer1M', 0),
	};
}

async function main(): Promise<number> {
	const opts = parseArgs(process.argv.slice(2));
	if (opts === 'help') {
		process.stdout.write(HELP);
		return 0;
	}

	let gitRoot: string;
	try {
		gitRoot = (await runGit(['rev-parse', '--show-toplevel'], process.cwd())).stdout.trim();
	} catch {
		console.error('aicommit: not a git repository');
		return 128;
	}

	const gitConfig = await readGitConfig(gitRoot);
	const cfg = buildConfig(gitConfig);
	const apiKey =
		process.env.GIT_AI_MESSAGE_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || gitConfig.get('apikey')?.trim() || null;
	const language =
		gitConfig.get('language') || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;

	// Before the first commit there is no HEAD to diff against; only the index can be committed then.
	const hasHead = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], gitRoot).then(() => true, () => false);
	const sources: ChangeSet['source'][] = opts.all && hasHead ? ['uncommitted'] : ['staged'];
	const changes = await getChanges(gitRoot, sources);
	if (!changes) {
		const unstaged = !opts.all && (await getChanges(gitRoot, ['unstaged']));
		console.error(
			unstaged
				? 'aicommit: nothing staged. Stage changes with `git add`, or use -a to commit all changes to tracked files.'
				: `aicommit: ${noChangesMessage(await getUntrackedFiles(gitRoot))}`,
		);
		return 1;
	}

	process.stderr.write(`Generating commit message (${cfg.model})…\n`);
	const { message, usage } = await generateCommitMessage({ cfg, apiKey, changes, language });
	const usageText = formatUsageAndCost(cfg, usage);
	if (usageText) {
		process.stderr.write(`${usageText}\n`);
	}

	if (opts.print) {
		process.stdout.write(`${message}\n`);
		return 0;
	}

	const args = ['commit', ...(opts.all ? ['-a'] : []), '-m', message, ...(opts.direct ? [] : ['-e']), ...opts.passthrough];
	const res = spawnSync('git', args, { cwd: process.cwd(), stdio: 'inherit' });
	if (res.error) {
		throw res.error;
	}
	return res.status ?? 1;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(`aicommit: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	},
);
