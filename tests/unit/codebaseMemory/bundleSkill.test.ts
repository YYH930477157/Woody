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

  it('isolates the imported skill directory from the large native bundle', () => {
    expect(existsSync(`${bundleDir}/SKILL.md`)).toBe(false);
    expect(readdirSync(skillDir)).toEqual(['SKILL.md']);
  });
});
