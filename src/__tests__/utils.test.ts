/**
 * Unit tests for shared translator utilities (utils.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  fixParamTypes,
  normalizeToolArgs,
  translateToolCallToNative,
  formatTranslatedResponse,
  collectToolSchemas,
} from '../proxy/translators/utils';

// ─── fixParamTypes ─────────────────────────────────────────────────────────

describe('fixParamTypes', () => {
  it('should lowercase top-level type', () => {
    const props: Record<string, unknown> = { type: { type: 'STRING', properties: {} } };
    fixParamTypes(props);
    expect((props.type as Record<string, string>).type).toBe('string');
  });

  it('should lowercase nested property types', () => {
    const props: Record<string, unknown> = {
      name: { type: 'STRING' },
      age: { type: 'NUMBER' },
    };
    fixParamTypes(props);
    expect((props.name as Record<string, string>).type).toBe('string');
    expect((props.age as Record<string, string>).type).toBe('number');
  });

  it('should handle items with type', () => {
    const props: Record<string, unknown> = {
      tags: { type: 'ARRAY', items: { type: 'STRING' } },
    };
    fixParamTypes(props);
    const tags = props.tags as Record<string, unknown>;
    expect(tags.type).toBe('array');
    expect((tags.items as Record<string, string>).type).toBe('string');
  });

  it('should handle nested properties inside items', () => {
    const props: Record<string, unknown> = {
      results: {
        type: 'ARRAY',
        items: { type: 'OBJECT', properties: { id: { type: 'INTEGER' } } },
      },
    };
    fixParamTypes(props);
    const results = props.results as Record<string, unknown>;
    expect(results.type).toBe('array');
    const items = results.items as Record<string, unknown>;
    expect(items.type).toBe('object');
    const itemProps = items.properties as Record<string, unknown>;
    expect((itemProps.id as Record<string, string>).type).toBe('integer');
  });

  it('should handle undefined gracefully', () => {
    expect(() => fixParamTypes(undefined)).not.toThrow();
  });

  it('should handle empty object', () => {
    expect(() => fixParamTypes({})).not.toThrow();
  });
});

// ─── normalizeToolArgs ─────────────────────────────────────────────────────

describe('normalizeToolArgs', () => {
  it('should return empty object for null/undefined', () => {
    expect(normalizeToolArgs('view_file', null)).toEqual({});
    expect(normalizeToolArgs('view_file', undefined)).toEqual({});
  });

  it('should normalize view_file args using aliases', () => {
    expect(normalizeToolArgs('view_file', { file_path: '/test.js' })).toEqual({ AbsolutePath: '/test.js' });
    expect(normalizeToolArgs('view_file', { filePath: '/a/b.ts' })).toEqual({ AbsolutePath: '/a/b.ts' });
    expect(normalizeToolArgs('view_file', { AbsolutePath: '/x.txt' })).toEqual({ AbsolutePath: '/x.txt' });
  });

  it('should normalize list_dir args', () => {
    expect(normalizeToolArgs('list_dir', { directory: '/src' })).toEqual({ DirectoryPath: '/src' });
    expect(normalizeToolArgs('list_dir', { dir: '/tmp' })).toEqual({ DirectoryPath: '/tmp' });
    expect(normalizeToolArgs('list_dir', { DirectoryPath: '/a' })).toEqual({ DirectoryPath: '/a' });
  });

  it('should normalize run_command args', () => {
    const result = normalizeToolArgs('run_command', { cmd: 'ls -la' });
    expect(result).toEqual({ CommandLine: 'ls -la' });
  });

  it('should normalize run_command.Cwd sub-key', () => {
    const result = normalizeToolArgs('run_command', { CommandLine: 'ls', cwd: '/home' });
    expect(result).toEqual({ CommandLine: 'ls', Cwd: '/home' });
  });

  it('should normalize grep_search args', () => {
    const result = normalizeToolArgs('grep_search', { pattern: 'TODO', directory: '/src' });
    expect(result).toEqual({ Query: 'TODO', SearchPath: '/src' });
  });

  it('should normalize replace_file_content args', () => {
    expect(normalizeToolArgs('replace_file_content', { file: '/a.ts' })).toEqual({ TargetFile: '/a.ts' });
    expect(normalizeToolArgs('replace_file_content', { TargetFile: '/b.ts' })).toEqual({ TargetFile: '/b.ts' });
  });

  it('should normalize write_file args', () => {
    expect(normalizeToolArgs('write_file', { path: '/out.ts' })).toEqual({ AbsolutePath: '/out.ts' });
    expect(normalizeToolArgs('write_file', { target: '/out2.ts' })).toEqual({ AbsolutePath: '/out2.ts' });
  });

  it('should normalize search_files args', () => {
    const result = normalizeToolArgs('search_files', { directory: '/src' });
    expect(result).toEqual({ SearchPath: '/src' });
  });

  it('should normalize create_directory args', () => {
    expect(normalizeToolArgs('create_directory', { path: '/new' })).toEqual({ DirectoryPath: '/new' });
  });

  it('should normalize delete_file args', () => {
    expect(normalizeToolArgs('delete_file', { file: '/old.js' })).toEqual({ AbsolutePath: '/old.js' });
  });

  it('should normalize move_file args', () => {
    expect(normalizeToolArgs('move_file', { source: '/a' })).toEqual({ SourcePath: '/a' });
    expect(normalizeToolArgs('move_file', { src: '/b' })).toEqual({ SourcePath: '/b' });
  });

  it('preserves unknown tool parameters rather than guessing a path schema', () => {
    const result = normalizeToolArgs('unknown_tool', { file_path: '/test.txt' });
    expect(result).toEqual({ file_path: '/test.txt' });
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'preserves custom tool %s without using inherited rules',
    (name) => {
      const args = { file_path: '/test.txt', content: 'hello' };
      expect(normalizeToolArgs(name, args)).toEqual(args);
    },
  );

  it('does not add AbsolutePath to a valid write_to_file call (issue #7)', () => {
    const args = { TargetFile: '/workspace/app.ts', CodeContent: 'console.log("hello");', Overwrite: false };
    expect(normalizeToolArgs('write_to_file', args)).toEqual(args);
    expect(normalizeToolArgs('writefile', args)).toEqual(args);
  });

  it('does not mistake contents or descriptions for a missing file path', () => {
    const args = { CodeContent: 'import fs from "node:fs";', Description: 'Save src/main.ts.' };
    expect(normalizeToolArgs('write_to_file', args)).toEqual(args);
    expect(normalizeToolArgs('write_file', args)).toEqual(args);
  });

  it('resolves an explicit write_to_file path alias without inventing other arguments', () => {
    const schema = new Map([['write_to_file', { properties: { TargetFile: {}, CodeContent: {}, Overwrite: {} } }]]);
    const args = { AbsolutePath: '/workspace/app.ts', CodeContent: 'hello', Overwrite: false };
    expect(normalizeToolArgs('write_to_file', args, schema)).toEqual({
      TargetFile: '/workspace/app.ts',
      CodeContent: 'hello',
      Overwrite: false,
    });
    expect(args).toHaveProperty('AbsolutePath');
  });

  it.each([true, false])('preserves canonical values regardless of alias order (%s)', (aliasFirst) => {
    const canonical = { TargetFile: '/requested.ts' };
    const alias = { AbsolutePath: '/other.ts' };
    const args = aliasFirst ? { ...alias, ...canonical } : { ...canonical, ...alias };
    expect(normalizeToolArgs('write_to_file', args)).toEqual(canonical);
  });

  it('retains both keys when the live schema declares them as independent parameters', () => {
    const schema = new Map([['write_file', { properties: { path: {}, AbsolutePath: {} } }]]);
    const args = { path: '/relative-context', AbsolutePath: '/explicit-target' };
    expect(normalizeToolArgs('write_file', args, schema)).toEqual(args);
  });

  it('does not rename a legacy alias unless its canonical target is declared', () => {
    const schema = new Map([['write_file', { properties: { destination: {}, content: {} } }]]);
    const args = { destination: '/target.txt', content: 'Text with a period.' };
    expect(normalizeToolArgs('write_file', args, schema)).toEqual(args);
  });

  it('preserves extra properties and nested values for the caller to validate', () => {
    const schema = new Map([['write_to_file', { properties: { TargetFile: {} }, additionalProperties: true }]]);
    const args = { TargetFile: '/file.txt', metadata: { path: '/nested', value: false }, custom: 'docs/file.md' };
    expect(normalizeToolArgs('write_to_file', args, schema)).toEqual(args);
  });

  it('does not apply legacy normalization to undeclared tools or opaque schemas', () => {
    const args = { path: '/file.txt' };
    expect(normalizeToolArgs('write_file', args, new Map())).toEqual(args);
    expect(normalizeToolArgs('write_file', args, new Map([['write_file', { $ref: '#/$defs/write' }]]))).toEqual(args);
  });

  it('should return original args for unknown tool without path-like keys', () => {
    const result = normalizeToolArgs('unknown_tool', { foo: 'bar' });
    expect(result).toEqual({ foo: 'bar' });
  });

  it('should handle array args for known tools', () => {
    const result = normalizeToolArgs('view_file', ['/single.js'] as unknown as Record<string, unknown>);
    expect(result).toEqual({ AbsolutePath: '/single.js' });
  });
});

describe('collectToolSchemas', () => {
  it('reads both declaration formats and prefers the full JSON schema', () => {
    const legacy = { type: 'OBJECT', properties: { AbsolutePath: { type: 'STRING' } } };
    const current = { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false };
    const body = {
      tools: [
        {
          functionDeclarations: [
            { name: 'legacy', parameters: legacy },
            { name: 'write_file', parameters: legacy, parametersJsonSchema: current },
          ],
        },
      ],
    };
    const collected = collectToolSchemas(body);
    expect(collected.get('legacy')).toEqual(legacy);
    expect(collected.get('write_file')).toEqual(current);
    expect(collectToolSchemas({ tools: [] }).size).toBe(0);
    expect(collected.size).toBe(2);
  });

  it('avoids guessing between conflicting duplicate declarations', () => {
    const tools = [
      {
        functionDeclarations: [
          { name: 'write_file', parameters: { properties: { path: {} } } },
          { name: 'write_file', parameters: { properties: { AbsolutePath: {} } } },
        ],
      },
    ];
    expect(normalizeToolArgs('write_file', { path: '/file.txt' }, collectToolSchemas({ tools }))).toEqual({
      path: '/file.txt',
    });
  });
});

// ─── translateToolCallToNative ──────────────────────────────────────────────

describe('translateToolCallToNative', () => {
  it('preserves declared shell calls instead of substituting an undeclared file tool', () => {
    const args = { CommandLine: 'echo hello > /tmp/out.txt', Cwd: '/tmp' };
    const schema = new Map([['run_command', { properties: { CommandLine: {}, Cwd: {} } }]]);
    expect(translateToolCallToNative('run_command', args, schema)).toEqual({ name: 'run_command', args });
  });
  it('should pass through non-run_command calls', () => {
    const result = translateToolCallToNative('view_file', { AbsolutePath: '/x.ts' });
    expect(result).toEqual({ name: 'view_file', args: { AbsolutePath: '/x.ts' } });
  });

  it('should translate ls to list_dir', () => {
    const result = translateToolCallToNative('run_command', {
      CommandLine: 'ls /home/user',
      Cwd: '/tmp',
    });
    expect(result.name).toBe('list_dir');
    expect(result.args).toHaveProperty('DirectoryPath');
  });

  it('should translate dir to list_dir (Windows)', () => {
    const result = translateToolCallToNative('run_command', {
      CommandLine: 'dir src',
      Cwd: 'C:\\project',
    });
    expect(result.name).toBe('list_dir');
  });

  it('should translate cat to view_file', () => {
    const result = translateToolCallToNative('run_command', {
      CommandLine: 'cat /etc/hosts',
      Cwd: '/',
    });
    expect(result.name).toBe('view_file');
    expect(result.args).toHaveProperty('AbsolutePath');
  });

  it('should translate type to view_file (Windows)', () => {
    const result = translateToolCallToNative('run_command', {
      CommandLine: 'type C:\\file.txt',
      Cwd: 'C:\\',
    });
    expect(result.name).toBe('view_file');
  });

  it('should translate echo redirect to write_file', () => {
    const result = translateToolCallToNative('run_command', {
      CommandLine: 'echo hello > /tmp/out.txt',
      Cwd: '/',
    });
    expect(result.name).toBe('write_file');
    expect(result.args).toHaveProperty('AbsolutePath');
  });

  it('should translate grep to grep_search', () => {
    const result = translateToolCallToNative('run_command', {
      CommandLine: 'grep -i "TODO" /src',
      Cwd: '/',
    });
    expect(result.name).toBe('grep_search');
    expect(result.args).toHaveProperty('Query', 'TODO');
    expect(result.args).toHaveProperty('CaseInsensitive', true);
  });

  it('should handle findstr (Windows grep)', () => {
    const result = translateToolCallToNative('run_command', {
      CommandLine: 'findstr /i TODO *.ts',
      Cwd: 'C:\\src',
    });
    expect(result.name).toBe('grep_search');
    expect(result.args).toHaveProperty('CaseInsensitive', true);
  });

  it('should pass through unknown commands', () => {
    const result = translateToolCallToNative('run_command', {
      CommandLine: 'npm install',
    });
    expect(result.name).toBe('run_command');
  });
});

// ─── formatTranslatedResponse ───────────────────────────────────────────────

describe('formatTranslatedResponse', () => {
  const info = { originalName: 'run_command', translatedName: 'list_dir', cmd: 'ls' };

  it('should format list_dir array response', () => {
    const result = formatTranslatedResponse(info, [
      { name: 'file.ts', isDir: false, sizeBytes: 100 },
      { name: 'src', isDir: true },
    ]);
    expect(result).toContain('file.ts');
    expect(result).toContain('src');
    expect(result).toContain('<DIR>');
  });

  it('should format list_dir object response with children', () => {
    const result = formatTranslatedResponse(info, {
      children: [{ name: 'a.ts', isDir: false }],
    });
    expect(result).toContain('a.ts');
  });

  it('should format view_file response', () => {
    const viewInfo = { ...info, translatedName: 'view_file' };
    const result = formatTranslatedResponse(viewInfo, { content: 'hello world' });
    expect(result).toBe('hello world');
  });

  it('should format grep_search response', () => {
    const grepInfo = { ...info, translatedName: 'grep_search' };
    const result = formatTranslatedResponse(grepInfo, [{ Filename: 'a.ts', LineNumber: 10, LineContent: 'TODO: fix' }]);
    expect(result).toContain('a.ts:10:TODO: fix');
  });

  it('should format write_file success response', () => {
    const writeInfo = { ...info, translatedName: 'write_file' };
    const result = formatTranslatedResponse(writeInfo, { success: true, path: '/out.ts' });
    expect(result).toContain('File written successfully');
  });

  it('should format write_file failure response', () => {
    const writeInfo = { ...info, translatedName: 'write_file' };
    const result = formatTranslatedResponse(writeInfo, { success: false, error: 'Permission denied' });
    expect(result).toContain('Failed to write file');
  });

  it('should fallback to JSON.stringify for unknown types', () => {
    const result = formatTranslatedResponse(info, 42);
    expect(result).toBe('42');
  });

  it('should fallback to string for string inputs', () => {
    const result = formatTranslatedResponse(info, 'plain text');
    expect(result).toBe('plain text');
  });
});
