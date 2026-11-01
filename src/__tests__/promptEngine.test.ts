import {
  applyPromptEngine,
  getClaudeCodePrompt,
  computeWorkspaceContext,
  CLAUDE_TOOLS_MAPPING_SECTION,
} from '../promptEngine';

describe('promptEngine with Antigravity tool mappings', () => {
  it('does not modify body when mode is antigravity', () => {
    const body: any = {
      systemInstruction: { parts: [{ text: 'Default Antigravity prompt' }] },
    };
    applyPromptEngine(body, 'antigravity');
    expect(body.systemInstruction.parts).toHaveLength(1);
    expect(body.systemInstruction.parts[0].text).toBe('Default Antigravity prompt');
  });

  it('injects complete Claude prompt mapped to Antigravity tools when mode is claude', () => {
    const body: any = {};
    applyPromptEngine(body, 'claude');
    expect(body.systemInstruction).toBeDefined();
    expect(body.systemInstruction.parts).toHaveLength(1);
    const text = body.systemInstruction.parts[0].text;
    expect(text).toContain('Doing tasks');
    expect(text).toContain('Executing actions with care');
    expect(text).toContain('run_command');
    expect(text).toContain('view_file');
    expect(text).toContain('replace_file_content');
    expect(text).toContain('write_to_file');
    expect(text).toContain('Tone, Style & Output Efficiency');
  });

  it('prepends Claude prompt to existing systemInstruction parts', () => {
    const body: any = {
      systemInstruction: { parts: [{ text: 'Base instructions from Antigravity' }] },
    };
    applyPromptEngine(body, 'claude');
    expect(body.systemInstruction.parts).toHaveLength(2);
    expect(body.systemInstruction.parts[0].text).toContain('run_command');
    expect(body.systemInstruction.parts[1].text).toBe('Base instructions from Antigravity');
  });

  it('does not duplicate Claude prompt if already injected', () => {
    const body: any = {
      systemInstruction: { parts: [{ text: 'Base instructions' }] },
    };
    applyPromptEngine(body, 'claude');
    expect(body.systemInstruction.parts).toHaveLength(2);
    applyPromptEngine(body, 'claude');
    expect(body.systemInstruction.parts).toHaveLength(2);
  });

  it('injects custom prompt text in custom mode', () => {
    const body: any = {};
    const customPrompt = 'Custom instruction set.';
    applyPromptEngine(body, 'custom', customPrompt);
    expect(body.systemInstruction.parts[0].text).toBe(customPrompt);
  });

  it('computes workspace context with environment and OS info', () => {
    const ctx = computeWorkspaceContext();
    expect(ctx).toContain('# Environment & Context');
    expect(ctx).toContain('Working directory:');
    expect(ctx).toContain('Platform:');
  });
});
