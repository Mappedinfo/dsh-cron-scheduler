import { readFile, rm, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import ts from 'typescript'

const PACKAGE_ID = '@mappedinfo/dsh-cron-scheduler'

await rm('lib', { recursive: true, force: true })

const rootNames = ts.sys.readDirectory('src', ['.ts', '.tsx'])
const program = ts.createProgram({
  rootNames,
  options: {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: true,
    verbatimModuleSyntax: true,
    declaration: true,
    emitDeclarationOnly: true,
    outDir: 'lib/types',
    rootDir: 'src',
  },
})
const emit = program.emit()
const diagnostics = ts.getPreEmitDiagnostics(program).concat(emit.diagnostics)
if (diagnostics.length > 0) {
  const host = {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  }
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, host))
  process.exit(1)
}

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: 'lib/index.js',
  external: ['@deepseek-ai/*', 'cordis', 'cron-parser'],
})

// 纯逻辑测试入口（无 @deepseek-ai 值导入，可脱离 DSH profile 直接运行）。
await build({
  entryPoints: ['src/test-entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: 'lib/test-entry.js',
  external: ['cron-parser'],
})

await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outfile: 'lib/client.js',
  sourcemap: true,
  jsx: 'automatic',
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      'var module = { exports: {} }; var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

for (const file of ['lib/index.js', 'lib/client.js']) {
  const text = await readFile(file, 'utf8')
  await writeFile(file, `${text.trim()}\n`)
}
