import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const compiled = ts.transpileModule(fs.readFileSync('src/customIpc.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
function fixture(version: string) {
  const exports: any = {};
  runInNewContext(compiled, { exports, require: (name: string) => name === 'electron' ? { app: { getVersion: () => version } } : {}, console });
  return exports;
}
describe('native completion notification ownership', () => {
  it.each(['2.24.0', '2.25.0', '', 'invalid'])('keeps legacy notifications on %s', version => {
    expect(fixture(version).hasNativeNotificationSettings()).toBe(false);
  });
  it.each(['2.26.0', '2.27.0', '3.0.0'])('does not broadcast a second completion sound on %s', version => {
    const api = fixture(version);
    expect(api.hasNativeNotificationSettings()).toBe(true);
    expect(api.playNativeCompletionSound()).toMatchObject({ success: true });
  });
});
