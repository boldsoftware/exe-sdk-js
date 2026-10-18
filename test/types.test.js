import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { fileURLToPath } from "node:url";

test("public package types expose only the VM-oriented API", () => {
  const file = fileURLToPath(new URL("./api-types.ts", import.meta.url));
  const program = ts.createProgram([file], {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  }));
});
