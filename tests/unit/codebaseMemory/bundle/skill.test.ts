import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bundleDir = 'resources/bundled-mcp/codebase-memory';
const skillDir = `${bundleDir}/skills/woody-codebase-memory`;
type ToolSchema = { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } };
const tools = JSON.parse(readFileSync(`${bundleDir}/tools.json`, 'utf8')) as ToolSchema[];

describe('bundled skill tool contract', () => {
  it('documents only tool calls and arguments exposed by the project adapter', () => {
    const skill = readFileSync(`${skillDir}/SKILL.md`, 'utf8');
    const calls = [...skill.matchAll(/`([a-z_]+)\((\{[^`]*?\})\)`/g)];
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const [, name, json] of calls) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema;
      expect(schema, name).toBeDefined();
      const args = JSON.parse(json) as Record<string, unknown>;
      expect(
        Object.keys(args).filter((key) => !Object.hasOwn(schema!.properties, key)),
        name
      ).toEqual([]);
      expect(schema!.required?.filter((key) => !Object.hasOwn(args, key)) || [], name).toEqual([]);
    }
  });

  it('offers feature tracing and keeps feature cards in one place with user corrections preserved', () => {
    const skill = readFileSync(`${skillDir}/SKILL.md`, 'utf8');
    const description = /^description: (.+)$/m.exec(skill)?.[1] ?? '';
    // The skills index only shows the description, so it must name the feature use case.
    expect(description).toMatch(/feature end to end/);
    expect(description).toContain('.woody/features');
    expect(skill).toContain('`.woody/features/<feature>.md`');
    expect(skill).toMatch(/Corrections from the user: .*Keep this section unchanged when you update the card/);
  });

  it('tells the model to read and follow the architecture file before changing code', () => {
    const skill = readFileSync(`${skillDir}/SKILL.md`, 'utf8');
    // Weaker models may never load the skill body; the always-visible description must say it.
    expect(/^description: (.+)$/m.exec(skill)?.[1]).toContain('.woody/architecture.md');
    expect(skill).toMatch(/Change rules come first/);
    expect(skill).toMatch(/keep that module's own style/);
    expect(skill).toMatch(/Never edit between the `woody:generated` markers/);
    expect(readFileSync(`${bundleDir}/index.cjs`, 'utf8')).toContain('.woody/architecture.md');
  });

  it('isolates the imported skill directory from the large native bundle', () => {
    expect(existsSync(`${bundleDir}/SKILL.md`)).toBe(false);
    expect(readdirSync(skillDir)).toEqual(['SKILL.md']);
  });
});
