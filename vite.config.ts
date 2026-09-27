import { defineConfig } from 'vitest/config';
import { transformWithEsbuild } from 'vite';
import { fileURLToPath } from 'node:url';

const source = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

// Vite 8 uses OXC by default, but OXC has a gap: in stage-3 decorator mode
// it does NOT lower TypeScript's `accessor` keyword (auto-accessor) to
// getter/setter, and Node.js 24 doesn't yet support `accessor` natively.
// OXC's legacy mode does lower `accessor` but uses the old (target, key,
// descriptor) call convention, which is incompatible with the stage-3
// decorator API used in this codebase (context.addInitializer, etc.).
// esbuild handles both correctly.
// TODO: remove this plugin once OXC supports stage-3 accessor lowering.
const esbuildDecoratorPlugin = {
    name: 'esbuild-ts-decorators',
    enforce: 'pre' as const,
    async transform(code: string, id: string) {
        if (!id.match(/\.[cm]?tsx?$/)) return;
        return transformWithEsbuild(code, id, {
            loader: 'ts',
            target: 'es2022',
            tsconfigRaw: {
                compilerOptions: {
                    experimentalDecorators: false,
                },
            },
        });
    },
};

export default defineConfig({
    plugins: [esbuildDecoratorPlugin],
    oxc: false,
    // Tests run against the sources: each package name resolves to its src/index.ts.
    resolve: {
        alias: [
            { find: /^@chronicle\/core$/, replacement: source('core') },
            { find: /^@chronicle\/unit-of-work$/, replacement: source('unit-of-work') },
            { find: /^@chronicle\/event-log$/, replacement: source('event-log') },
        ],
    },
    test: {
        exclude: ['.claude/**', 'node_modules/**'],
    },
});
