# Git AI Message

Generate commit messages from your changes via the OpenAI API (Responses API) and automatically fill the VS Code Git commit input box.

日本語README: [README.ja.md](README.ja.md)

## Features

- Uses staged changes (`git diff --cached`); if nothing is staged, falls back to unstaged changes to tracked files (`git diff`). Untracked files are not included
- Fills the Git commit input box (it **does not** run `git commit`)
- Multi-repository workspaces: the ✨ button acts on its own repository; from the Command Palette the repository of the active editor is used, otherwise you are asked to pick one
- Output language follows VS Code UI language (Japanese if `vscode.env.language` starts with `ja`, otherwise English), unless your format instruction specifies otherwise
- Fully customizable output format (e.g., Conventional Commits, bullets-only, etc.)
- Optional notification showing token usage and estimated cost

## Requirements

- VS Code (extension engine: `^1.107.0`)
- Built-in Git extension enabled (`vscode.git`)
- OpenAI API key (optional; sent only when set — not needed for a local proxy at the default base URL)

## Installation

- From Marketplace (if published): search for “Git AI Message” in VS Code Extensions and install
- From VSIX: Extensions view → `...` → “Install from VSIX…”

## Quick Start

1. (Optional, only if your endpoint requires a key) Run `Git AI Message: Set OpenAI API Key` to store your API key (saved in Secret Storage).
2. Stage changes (`git add ...`), or leave them unstaged.
3. Generate a message using either:
   - Command Palette: `Git AI Message: Generate commit message`
   - The ✨ button in the Source Control view title bar
4. Review/edit the inserted message and commit as usual.

If both staged and unstaged diffs are empty, the extension shows a warning.

## Commands

| Command | Description |
| --- | --- |
| `Git AI Message: Generate commit message` | Generates a commit message and fills the commit input box |
| `Git AI Message: Set OpenAI API Key` | Stores your API key (Secret Storage) |
| `Git AI Message: Delete OpenAI API Key` | Deletes the stored API key |

## Configuration

Edit `gitAIMessage.*` in VS Code Settings.

| Setting | Purpose | Default |
| --- | --- | --- |
| `gitAIMessage.apiBaseUrl` | OpenAI API base URL | `http://127.0.0.1:8000` |
| `gitAIMessage.model` | Model name | `gpt-5.1` |
| `gitAIMessage.additionalInstructions` | Extra instruction (high priority) | (localized default) |
| `gitAIMessage.formatInstruction` | Output format (highest priority) | (localized default) |
| `gitAIMessage.maxDiffChars` | Max diff chars to analyze | `12000` |
| `gitAIMessage.temperature` | Randomness (0–2) | `0.2` |
| `gitAIMessage.maxOutputTokens` | Max output tokens | `200` |
| `gitAIMessage.showUsageInNotification` | Show usage/cost in notification | `true` |
| `gitAIMessage.currency` | Currency label (display only) | `USD` |
| `gitAIMessage.priceInputPer1M` / `gitAIMessage.priceOutputPer1M` | Prices per 1M tokens (for estimation) | `0` |

### Output Format (`gitAIMessage.formatInstruction`)

If set, the extension instructs the model to follow the format **exactly** (highest priority).
If empty, the default behavior is to generate a **single-line subject only** (no body).

Examples:

- `Line 1 must be type(scope): subject (<= 72 chars). Line 2 blank. Lines 3+ are "- " bullets.`
- `English only. One line: "Summary: ...". No body.`

## Security / Privacy

- What is sent: the diff (`git diff --cached`, or `git diff` when nothing is staged) and its `--stat` summary are sent to the OpenAI API. Be careful with sensitive repositories.
- API: OpenAI Responses API (`POST {apiBaseUrl}/responses`).
- Requests include `store: false` (note: retention can still be affected by org/account settings).
- If the diff exceeds `gitAIMessage.maxDiffChars`, it is truncated and a notice is appended (`[...truncated to N chars...]`).
- Your API key is stored in VS Code Secret Storage.

## Troubleshooting

- “No changes found”: there are no changes to tracked files (untracked files need `git add`).
- “Could not apply the commit message”: make sure the built-in Git extension (`vscode.git`) is enabled.
- “OpenAI API error”: verify your API key, `gitAIMessage.apiBaseUrl`, model name, and network environment.

## Development

- `pnpm install`
- `pnpm run compile` (typecheck + lint + build)
- `pnpm run package` (production build)

## License

GPL-3.0-only. See `LICENSE`.
