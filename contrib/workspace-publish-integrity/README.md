# Workspace Publish Integrity

This contributor-only implementation covers issues #619, #620, #621, and #622.
Repository policy requires external changes to remain under `contrib/`, so the
checks and fixtures are executable here while every required root, workflow,
and contribution-guide edit is documented for a maintainer integration commit.

## Local validation

```sh
npx vitest run contrib/workspace-publish-integrity
node contrib/workspace-publish-integrity/public-export-check.mjs .
node contrib/workspace-publish-integrity/breaking-release.mjs 1.0.0 .
```

The two packaging rehearsals require the repository baseline to build:

```sh
node contrib/workspace-publish-integrity/workspace-local-source.mjs .
node contrib/workspace-publish-integrity/standalone-install.mjs packages/cli .
node contrib/workspace-publish-integrity/standalone-install.mjs packages/mcp-x402-payer .
```

## #621: reject imports of unexported SDK symbols

`public-export-check.mjs` uses the TypeScript compiler API to obtain each public
entry point's real symbol table. It scans the CLI and MCP payer source trees for
value imports, type-only imports, aliased imports, and named re-exports from
`vellar-sdk`.

- Root imports are checked against `src/index.ts`.
- Subpath imports such as `vellar-sdk/x402-guards` are checked against the
  matching `package.json` export's `source` entry.
- Missing package subpaths and missing symbols are both fatal.
- Namespace imports remain valid because they do not claim a specific symbol.

The `fixtures/unexported-type` workspace imports `InternalOnly`, which exists in
an internal file but is deliberately absent from `src/index.ts`; the test proves
that exact published-consumer failure is detected. The live repository test
also confirms every current CLI/MCP import is public.

### Maintainer integration

Add a root script and run it before the existing TypeScript commands:

```json
"check:public-workspace-imports": "node contrib/workspace-publish-integrity/public-export-check.mjs .",
"typecheck": "npm run check:public-workspace-imports && tsc --noEmit && tsc --noEmit -p packages/mcp-x402-payer/tsconfig.json && tsc --noEmit -p packages/cli/tsconfig.json"
```

No new dependency is required because TypeScript is already a root dev
dependency.

## #619: coordinated breaking releases

`breaking-release.mjs` accepts the next SDK version, verifies that it is a major
increase, and discovers every workspace whose declared SDK range excludes that
version. Dry-run is the default:

```sh
node contrib/workspace-publish-integrity/breaking-release.mjs 1.0.0 .
```

Write mode updates the root version, each excluded range, and each dependent
package version. It prompts separately for every dependent bump, accepting
`patch`, `minor`, `major`, or an exact version:

```sh
node contrib/workspace-publish-integrity/breaking-release.mjs 1.0.0 . --write
```

Automation can supply choices explicitly while retaining the same validation:

```sh
node contrib/workspace-publish-integrity/breaking-release.mjs 1.0.0 . --write \
  --bump vellar-cli=minor \
  --bump vellar-mcp-x402-payer=patch
```

The fixture starts at the real versions (`0.6.2`, `0.1.1`, `0.1.5`) and proves
that a `1.0.0` release updates both dependent ranges and package versions. An
unrelated workspace is not changed.

### Maintainer integration

1. Add a root script:

   ```json
   "release:breaking": "node contrib/workspace-publish-integrity/breaking-release.mjs"
   ```

2. Add this process to `CONTRIBUTING.md`:
   - run `npm run release:breaking -- <next-major> . --write`;
   - choose a bump for every affected workspace;
   - run `npm install --package-lock-only` to synchronize lockfile versions;
   - review root, CLI, MCP payer, and lockfile changes together;
   - run typecheck, tests, builds, and standalone package checks;
   - publish SDK first, then both dependent packages from the same approved
     release change.

## #620: prove builds resolve workspace-local SDK source

`workspace-local-source.mjs` first resolves `node_modules/vellar-sdk` through
the filesystem and requires it to point to the repository root. It then:

1. appends a unique random type marker to `src/index.ts`;
2. temporarily re-exports that type from each workspace `src/index.ts`;
3. builds the root SDK, CLI, and MCP payer through their normal build scripts;
4. requires each workspace declaration output to contain the unique marker;
5. restores every edited source file in a `finally` block, on success or error.

If a workspace resolves the registry package, the marker type is missing and
its declaration build fails. If a build silently ignores the probe, the output
assertion fails. The marker is type-only, so it cannot alter runtime behavior.

### Maintainer integration

Add this step after `npm ci` and before ordinary builds in
`.github/workflows/ci.yml`:

```yaml
      - name: Verify workspace packages build against local SDK source
        run: node contrib/workspace-publish-integrity/workspace-local-source.mjs .
```

Document in `CONTRIBUTING.md` that `node_modules/vellar-sdk` must be npm's
workspace link to the repository root, never a registry copy. A lockfile update
that breaks that link must fail CI.

## #622: isolated package installation matrix

`standalone-install.mjs` packs the local SDK and one workspace package, creates
a temporary consumer outside the monorepo, installs only those tarballs and
their declared dependencies, validates published entries, and runs the package
smoke behavior:

- CLI: `vellar --help` must exit 0.
- MCP payer: startup with credential variables removed must reach its expected
  configuration guard. A missing module fails before that guard and is rejected.

Installing the local SDK tarball explicitly ensures this check tests the commit
under review instead of the latest registry release. The clean consumer cannot
see hoisted root dev dependencies.

### Maintainer integration

Add this job to `.github/workflows/ci.yml`:

```yaml
  standalone-workspace-package:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        package-directory:
          - packages/cli
          - packages/mcp-x402-payer
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm run build --workspace vellar-cli
      - run: npm run build --workspace vellar-mcp-x402-payer
      - name: Pack, install, and smoke test
        run: node contrib/workspace-publish-integrity/standalone-install.mjs ${{ matrix.package-directory }} .
```

## Scope boundary

This proposal intentionally does not modify `package.json`, `package-lock.json`,
`.github/workflows/ci.yml`, `CONTRIBUTING.md`, source files, or workspace
manifests. Those maintainer-owned changes are fully specified above.
