import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { definitions } from '../src/core/tool-input';

const root = resolve('plugins/chatgpt');
const read = (path: string) => readFileSync(path, 'utf8');
const json = (path: string) => JSON.parse(read(path));
it.each(['plugin', 'mcp'])('validates %s.json against the vendored Agent Plugins schema', name => {
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(json(`test/schemas/agent-plugins/${name}.schema.json`));
  expect(validate(json(`${root}/${name}.json`)), JSON.stringify(validate.errors)).toBe(true);
});
it('includes all referenced assets and skills and valid review tool names', () => {
  const plugin = json(`${root}/plugin.json`);
  const openai = plugin.extensions['com.openai'];
  for (const path of [openai.interface.composerIcon, openai.interface.logo, openai.interface.logoDark, openai.onboardingSkill]) {
    expect(existsSync(resolve(root, path)), path).toBe(true);
  }
  for (const skill of ['get-started', 'find-providers', 'read-editorial', 'directory-statistics']) {
    expect(existsSync(resolve(root, 'skills', skill, 'SKILL.md'))).toBe(true);
  }
  const match = read(`${root}/README.md`).match(/```json\n([\s\S]*?)\n```/);
  expect(match).not.toBeNull();
  const cases = JSON.parse(match![1]!);
  expect(cases.positive).toHaveLength(5); expect(cases.negative).toHaveLength(3);
  for (const item of cases.positive) for (const tool of item.tools_triggered.split(', ')) {
    expect(tool in definitions, tool).toBe(true);
  }
});
