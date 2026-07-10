import { BridgeService } from '../bridge-service.js';
import {
  canonicalBuiltInSkillName,
  parseBuiltInStudioSkills,
} from '../studio-skills.js';
import { RobloxStudioTools } from '../tools/index.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MAGIC = Buffer.from('<roblox!\x89\xff\r\n\x1a\n', 'latin1');

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value);
  return buffer;
}

function rbxString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([uint32(bytes.length), bytes]);
}

function chunk(type: string, content = Buffer.alloc(0)): Buffer {
  return Buffer.concat([
    Buffer.from(type, 'latin1'),
    uint32(0),
    uint32(content.length),
    Buffer.alloc(4),
    content,
  ]);
}

function propChunk(classId: number, name: string, values: string[]): Buffer {
  return chunk('PROP', Buffer.concat([
    uint32(classId),
    rbxString(name),
    Buffer.from([0x01]),
    ...values.map(rbxString),
  ]));
}

function buildFixture(): Buffer {
  const base = [
    '---',
    'name: docs-search',
    'description: Find Roblox docs.',
    '---',
    '# Base document',
  ].join('\n');
  const combined = [
    '---',
    'name: docs-search',
    'description: Find Roblox docs with bundled references.',
    '---',
    '# Combined document',
  ].join('\n');
  const debug = [
    '---',
    'name: rbx-debug',
    'description: Debug scripts.',
    '---',
    '# Debug',
  ].join('\n');
  const names = ['SKILL', 'SKILL-combined', 'SKILL'];
  const values = [base, combined, debug];
  const inst = Buffer.concat([
    uint32(7),
    rbxString('StringValue'),
    Buffer.from([0]),
    uint32(names.length),
    Buffer.alloc(names.length * 4),
  ]);
  const header = Buffer.concat([
    MAGIC,
    Buffer.alloc(2),
    int32(1),
    int32(names.length),
    Buffer.alloc(8),
  ]);
  return Buffer.concat([
    header,
    chunk('INST', inst),
    propChunk(7, 'Name', names),
    propChunk(7, 'Value', values),
    chunk('END\0'),
  ]);
}

interface SkillsResultBody {
  action: string;
  source: string;
  bundlePath: string;
  count: number;
  skills: Array<Record<string, unknown>>;
  skill: {
    name: string;
    content: string;
  };
}

function resultBody(
  result: Awaited<ReturnType<RobloxStudioTools['getRobloxSkills']>>,
): SkillsResultBody {
  return JSON.parse(result.content[0].text) as SkillsResultBody;
}

describe('installed Studio skills', () => {
  test('extracts skill StringValues, prefers combined documents, and canonicalizes names', () => {
    const skills = parseBuiltInStudioSkills(buildFixture());

    expect(skills.map((skill) => skill.name)).toEqual(['rbx-debug', 'rbx-docs-search']);
    const docs = skills.find((skill) => skill.name === 'rbx-docs-search')!;
    expect(docs.sourceName).toBe('docs-search');
    expect(docs.document).toBe('SKILL-combined');
    expect(docs.hasCombinedDocument).toBe(true);
    expect(docs.description).toBe('Find Roblox docs with bundled references.');
    expect(docs.content).toContain('# Combined document');
    expect(docs.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalBuiltInSkillName('rbx-debug')).toBe('rbx-debug');
  });

  test('rejects non-Roblox binary input', () => {
    expect(() => parseBuiltInStudioSkills(Buffer.from('not an rbxm'))).toThrow(
      'Roblox binary model header not found',
    );
  });

  test('get_roblox_skills lists metadata and gets by canonical or source name', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-skills-test-'));
    const bundlePath = path.join(directory, 'Assistant.rbxm');
    fs.writeFileSync(bundlePath, buildFixture());
    const previousOverride = process.env.ROBLOX_STUDIO_ASSISTANT_BUNDLE;
    process.env.ROBLOX_STUDIO_ASSISTANT_BUNDLE = bundlePath;

    try {
      const tools = new RobloxStudioTools(new BridgeService());
      const listed = resultBody(await tools.getRobloxSkills('list'));
      expect(listed.action).toBe('list');
      expect(listed.source).toBe('installed-studio-assistant');
      expect(listed.bundlePath).toBe(bundlePath);
      expect(listed.count).toBe(2);
      expect(listed.skills[0]).not.toHaveProperty('content');

      const canonical = resultBody(await tools.getRobloxSkills('get', 'rbx-docs-search'));
      expect(canonical.skill.content).toContain('# Combined document');
      const source = resultBody(await tools.getRobloxSkills('get', 'docs-search'));
      expect(source.skill.name).toBe('rbx-docs-search');
      await expect(tools.getRobloxSkills('get', 'missing')).rejects.toThrow(
        /Available skills: rbx-debug, rbx-docs-search/,
      );
    } finally {
      if (previousOverride === undefined) delete process.env.ROBLOX_STUDIO_ASSISTANT_BUNDLE;
      else process.env.ROBLOX_STUDIO_ASSISTANT_BUNDLE = previousOverride;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
