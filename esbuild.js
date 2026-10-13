const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const common = {
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	};
	const contexts = await Promise.all([
		esbuild.context({
			...common,
			entryPoints: ['src/extension.ts'],
			outfile: 'dist/extension.js',
			external: ['vscode'],
		}),
		esbuild.context({
			...common,
			entryPoints: ['src/cli.ts'],
			outfile: 'dist/cli.js',
			banner: { js: '#!/usr/bin/env node' },
		}),
	]);
	if (watch) {
		await Promise.all(contexts.map((ctx) => ctx.watch()));
	} else {
		for (const ctx of contexts) {
			await ctx.rebuild();
			await ctx.dispose();
		}
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
