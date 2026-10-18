import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(fullPath));
    else if (entry.isFile() && SOURCE_EXTENSION.test(entry.name)) files.push(fullPath);
  }
  return files;
}

function moduleSpecifier(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
  }
  return null;
}

export function importedNames(sourceText, fileName, packageName) {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const imports = [];

  for (const statement of source.statements) {
    const specifier = moduleSpecifier(statement);
    if (specifier !== packageName && !specifier?.startsWith(`${packageName}/`)) continue;

    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) imports.push({ specifier, name: "default" });
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          imports.push({ specifier, name: (element.propertyName ?? element.name).text });
        }
      }
    } else if (ts.isExportDeclaration(statement) && statement.exportClause &&
      ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        imports.push({ specifier, name: (element.propertyName ?? element.name).text });
      }
    }
  }

  return imports;
}

function sourceEntryForSpecifier(manifest, rootDirectory, specifier) {
  const subpath = specifier === manifest.name ? "." : `.${specifier.slice(manifest.name.length)}`;
  const entry = manifest.exports?.[subpath];
  const source = typeof entry === "object" && entry !== null ? entry.source : null;
  return typeof source === "string"
    ? path.resolve(rootDirectory, source)
    : null;
}

function exportedNameMap(entryFiles) {
  const program = ts.createProgram(entryFiles, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  return new Map(entryFiles.map((entryFile) => {
    const source = program.getSourceFile(entryFile);
    const symbol = source && checker.getSymbolAtLocation(source);
    if (!symbol) throw new Error(`Could not resolve the export surface for ${entryFile}`);
    return [entryFile, new Set(checker.getExportsOfModule(symbol).map((entry) => entry.name))];
  }));
}

export function exportedNames(entryFile) {
  return exportedNameMap([entryFile]).get(entryFile);
}

export async function auditPublicImports({ rootDirectory, workspaceSourceDirectories }) {
  const manifest = JSON.parse(await readFile(path.join(rootDirectory, "package.json"), "utf8"));
  const violations = [];
  const requests = [];

  for (const sourceDirectory of workspaceSourceDirectories) {
    for (const filePath of await sourceFiles(sourceDirectory)) {
      const sourceText = await readFile(filePath, "utf8");
      for (const imported of importedNames(sourceText, filePath, manifest.name)) {
        const entryFile = sourceEntryForSpecifier(manifest, rootDirectory, imported.specifier);
        if (!entryFile) {
          violations.push({
            filePath,
            specifier: imported.specifier,
            name: imported.name,
            reason: "package subpath is not publicly exported",
          });
          continue;
        }
        requests.push({ ...imported, filePath, entryFile });
      }
    }
  }

  const exportCache = exportedNameMap([...new Set(requests.map((request) => request.entryFile))]);
  for (const request of requests) {
    if (!exportCache.get(request.entryFile).has(request.name)) {
          violations.push({
            filePath: request.filePath,
            specifier: request.specifier,
            name: request.name,
            reason: "symbol is not exported by the public entry point",
          });
    }
  }

  return violations;
}

async function main() {
  const rootDirectory = path.resolve(process.argv[2] ?? ".");
  const workspaceSourceDirectories = (process.argv.slice(3).length > 0
    ? process.argv.slice(3)
    : ["packages/cli/src", "packages/mcp-x402-payer/src"])
    .map((directory) => path.resolve(rootDirectory, directory));
  const violations = await auditPublicImports({ rootDirectory, workspaceSourceDirectories });

  if (violations.length === 0) {
    console.log("[OK] Workspace imports use only public vellar-sdk exports");
    return;
  }
  for (const violation of violations) {
    console.error(
      `[ERROR] ${path.relative(rootDirectory, violation.filePath)} imports ` +
        `${violation.name} from ${violation.specifier}: ${violation.reason}`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
