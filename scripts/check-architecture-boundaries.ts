import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export interface SourceBoundaryFile {
  path: string;
  source: string;
}

// `document` is also a core domain noun (FetchedDocument and recipe.document),
// so the static pass leaves that ambiguous identifier to review. Chrome types
// are absent from tsconfig.shared; the remaining names are unambiguous here.
const PLATFORM_GLOBALS = new Set(["chrome", "window", "navigator", "localStorage", "sessionStorage"]);

export function architectureBoundaryIssues(files: readonly SourceBoundaryFile[]): string[] {
  const issues: string[] = [];
  for (const file of files) {
    const normalizedPath = file.path.replaceAll("\\", "/");
    const shared = normalizedPath.startsWith("src/");
    const collector = normalizedPath.startsWith("collector/");
    if (!shared && !collector) continue;

    const sourceFile = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = node.moduleSpecifier.text.replaceAll("\\", "/");
        if (shared && /(?:^|\/)(?:collector|studio)(?:\/|$)/.test(target)) {
          issues.push(`${file.path}: shared code imports platform code (${target})`);
        }
        if (collector && /(?:^|\/)studio(?:\/|$)/.test(target)) {
          issues.push(`${file.path}: Collector imports Studio code (${target})`);
        }
      }
      if (shared && ts.isIdentifier(node) && PLATFORM_GLOBALS.has(node.text) && isValueReference(node)) {
        issues.push(`${file.path}: shared code references platform global ${node.text}`);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "click" &&
        !isApprovedPageActivation(normalizedPath, node)
      ) {
        issues.push(`${file.path}: raw page click is outside an approved action-scoped controller`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...new Set(issues)];
}

function isApprovedPageActivation(path: string, node: ts.Node): boolean {
  const approved = path === "collector/src/platform/document-action-controller.ts"
    ? new Set(["runSemanticDocumentOperationInPage", "advanceDomPageInPage"])
    : path === "collector/src/platform/discovery.ts"
      ? new Set(["collectPageEvidenceInPage"])
      : new Set<string>();
  if (!approved.size) return false;
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name && approved.has(current.name.text)) return true;
  }
  return false;
}

function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isBindingElement(parent)) return false;
  return true;
}

function sourceFiles(directory: string): SourceBoundaryFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [{ path, source: readFileSync(path, "utf8") }] : [];
  });
}

function main(): void {
  const issues = architectureBoundaryIssues([...sourceFiles("src"), ...sourceFiles("collector")]);
  if (issues.length) throw new Error(`architecture boundary violations:\n- ${issues.join("\n- ")}`);
  console.log("✓ shared core is platform-free and Collector does not import Studio");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
