import { createHash } from 'crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'fs';
import * as path from 'path';
import { decompress as decompressZstd } from 'fzstd';
import { resolveStudioExe } from './studio-instance-manager.js';

const RBXM_MAGIC = Buffer.from('<roblox!\x89\xff\r\n\x1a\n', 'latin1');
const RBXM_HEADER_BYTES = 32;
const RBXM_CHUNK_HEADER_BYTES = 16;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const STRING_PROPERTY_TYPE = 0x01;
const MAX_DISCOVERY_DEPTH = 6;

type SkillDocumentName = 'SKILL' | 'SKILL-combined';

interface StringValueClass {
  count: number;
  names?: string[];
  values?: string[];
}

interface ParsedSkillDocument {
  document: SkillDocumentName;
  sourceName: string;
  description: string;
  content: string;
}

export interface BuiltInStudioSkill {
  /** Slash-command style name exposed by Roblox for built-in skills. */
  name: string;
  /** Name stored in the skill document's frontmatter. */
  sourceName: string;
  description: string;
  document: SkillDocumentName;
  hasCombinedDocument: boolean;
  content: string;
  contentLength: number;
  contentSha256: string;
}

export interface BuiltInStudioSkillsBundle {
  bundlePath: string;
  bundleModifiedAt: string;
  bundleSha256: string;
  studioVersion?: string;
  skills: BuiltInStudioSkill[];
}

class ByteReader {
  private offset = 0;

  constructor(
    private readonly bytes: Buffer,
    private readonly label: string,
  ) {}

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  private requireBytes(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.remaining < length) {
      throw new Error(
        `Invalid ${this.label}: requested ${length} bytes with ${this.remaining} remaining`,
      );
    }
  }

  readUint8(): number {
    this.requireBytes(1);
    return this.bytes[this.offset++];
  }

  readUint16(): number {
    this.requireBytes(2);
    const value = this.bytes.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  readUint32(): number {
    this.requireBytes(4);
    const value = this.bytes.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readInt32(): number {
    this.requireBytes(4);
    const value = this.bytes.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readBytes(length: number): Buffer {
    this.requireBytes(length);
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  skip(length: number): void {
    this.requireBytes(length);
    this.offset += length;
  }

  readString(): string {
    const length = this.readUint32();
    return this.readBytes(length).toString('utf8');
  }
}

function decompressLz4Block(input: Buffer, outputLength: number): Buffer {
  const output = Buffer.allocUnsafe(outputLength);
  let inputOffset = 0;
  let outputOffset = 0;

  const readExtendedLength = (initial: number): number => {
    let length = initial;
    if (initial !== 15) return length;
    let next = 255;
    while (next === 255) {
      if (inputOffset >= input.length) {
        throw new Error('Invalid LZ4 chunk: truncated extended length');
      }
      next = input[inputOffset++];
      length += next;
    }
    return length;
  };

  while (inputOffset < input.length) {
    const token = input[inputOffset++];
    const literalLength = readExtendedLength(token >>> 4);
    if (inputOffset + literalLength > input.length || outputOffset + literalLength > output.length) {
      throw new Error('Invalid LZ4 chunk: literal exceeds chunk boundary');
    }
    input.copy(output, outputOffset, inputOffset, inputOffset + literalLength);
    inputOffset += literalLength;
    outputOffset += literalLength;

    // The last sequence may consist only of literals.
    if (inputOffset === input.length) break;
    if (inputOffset + 2 > input.length) {
      throw new Error('Invalid LZ4 chunk: missing match offset');
    }

    const matchOffset = input.readUInt16LE(inputOffset);
    inputOffset += 2;
    if (matchOffset === 0 || matchOffset > outputOffset) {
      throw new Error('Invalid LZ4 chunk: invalid match offset');
    }

    const matchLength = readExtendedLength(token & 0x0f) + 4;
    if (outputOffset + matchLength > output.length) {
      throw new Error('Invalid LZ4 chunk: match exceeds output boundary');
    }
    for (let index = 0; index < matchLength; index += 1) {
      output[outputOffset] = output[outputOffset - matchOffset];
      outputOffset += 1;
    }
  }

  if (outputOffset !== output.length) {
    throw new Error(
      `Invalid LZ4 chunk: produced ${outputOffset} bytes, expected ${output.length}`,
    );
  }
  return output;
}

function decompressChunk(compressed: Buffer, outputLength: number): Buffer {
  if (compressed.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
    const decompressed = Buffer.from(decompressZstd(compressed));
    if (decompressed.length !== outputLength) {
      throw new Error(
        `Invalid Zstandard chunk: produced ${decompressed.length} bytes, expected ${outputLength}`,
      );
    }
    return decompressed;
  }
  return decompressLz4Block(compressed, outputLength);
}

function readChunk(reader: ByteReader): { type: string; content?: Buffer } {
  if (reader.remaining < RBXM_CHUNK_HEADER_BYTES) {
    throw new Error('Invalid Assistant.rbxm: truncated chunk header');
  }
  const type = reader.readBytes(4).toString('latin1');
  const compressedLength = reader.readUint32();
  const uncompressedLength = reader.readUint32();
  reader.skip(4); // Reserved.

  if (type === 'END\0') return { type };
  if (compressedLength === 0) {
    return { type, content: reader.readBytes(uncompressedLength) };
  }
  return {
    type,
    content: decompressChunk(reader.readBytes(compressedLength), uncompressedLength),
  };
}

function parseFrontmatter(markdown: string): { name: string; description: string } | undefined {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;

  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        // Preserve the original scalar if it is not valid JSON quoting.
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    fields.set(key, value);
  }

  const name = fields.get('name')?.trim();
  if (!name) return undefined;
  return { name, description: fields.get('description')?.trim() ?? '' };
}

export function canonicalBuiltInSkillName(sourceName: string): string {
  return sourceName.toLowerCase().startsWith('rbx-') ? sourceName : `rbx-${sourceName}`;
}

/**
 * Extract built-in skill documents from the StringValue records embedded in
 * Studio's Assistant.rbxm. This intentionally parses only INST and string
 * PROP chunks; protected ModuleScript bytecode and the rest of the model are
 * irrelevant to skill discovery.
 */
export function parseBuiltInStudioSkills(buffer: Buffer): BuiltInStudioSkill[] {
  if (buffer.length < RBXM_HEADER_BYTES || !buffer.subarray(0, RBXM_MAGIC.length).equals(RBXM_MAGIC)) {
    throw new Error('Invalid Assistant.rbxm: Roblox binary model header not found');
  }

  const reader = new ByteReader(buffer, 'Assistant.rbxm');
  reader.skip(RBXM_MAGIC.length);
  reader.readUint16(); // Binary format version.
  reader.readInt32(); // Class count.
  reader.readInt32(); // Instance count.
  reader.skip(8); // Reserved.

  const stringValueClasses = new Map<number, StringValueClass>();
  let foundEnd = false;

  while (reader.remaining > 0) {
    const chunk = readChunk(reader);
    if (chunk.type === 'END\0') {
      foundEnd = true;
      break;
    }
    if (!chunk.content) continue;

    const chunkReader = new ByteReader(chunk.content, `${chunk.type} chunk`);
    if (chunk.type === 'INST') {
      const classId = chunkReader.readUint32();
      const className = chunkReader.readString();
      chunkReader.readUint8(); // isService
      const count = chunkReader.readUint32();
      chunkReader.skip(count * 4); // Interleaved referent IDs.
      if (className === 'StringValue') stringValueClasses.set(classId, { count });
      continue;
    }

    if (chunk.type !== 'PROP') continue;
    const classId = chunkReader.readUint32();
    const propertyName = chunkReader.readString();
    const propertyType = chunkReader.readUint8();
    const classInfo = stringValueClasses.get(classId);
    if (!classInfo || propertyType !== STRING_PROPERTY_TYPE) continue;
    if (propertyName !== 'Name' && propertyName !== 'Value') continue;

    const values: string[] = [];
    for (let index = 0; index < classInfo.count; index += 1) {
      values.push(chunkReader.readString());
    }
    if (propertyName === 'Name') classInfo.names = values;
    else classInfo.values = values;
  }

  if (!foundEnd) throw new Error('Invalid Assistant.rbxm: END chunk not found');

  const documents: ParsedSkillDocument[] = [];
  for (const classInfo of stringValueClasses.values()) {
    if (!classInfo.names || !classInfo.values) continue;
    for (let index = 0; index < classInfo.count; index += 1) {
      const document = classInfo.names[index];
      if (document !== 'SKILL' && document !== 'SKILL-combined') continue;
      const content = classInfo.values[index];
      const frontmatter = parseFrontmatter(content);
      if (!frontmatter) continue;
      documents.push({
        document,
        sourceName: frontmatter.name,
        description: frontmatter.description,
        content,
      });
    }
  }

  const grouped = new Map<string, { base?: ParsedSkillDocument; combined?: ParsedSkillDocument }>();
  for (const document of documents) {
    const key = document.sourceName.toLowerCase();
    const group = grouped.get(key) ?? {};
    if (document.document === 'SKILL-combined') group.combined = document;
    else group.base = document;
    grouped.set(key, group);
  }

  return [...grouped.values()]
    .map((group) => {
      const selected = group.combined ?? group.base!;
      return {
        name: canonicalBuiltInSkillName(selected.sourceName),
        sourceName: selected.sourceName,
        description: selected.description,
        document: selected.document,
        hasCombinedDocument: group.combined !== undefined,
        content: selected.content,
        contentLength: Buffer.byteLength(selected.content, 'utf8'),
        contentSha256: createHash('sha256').update(selected.content).digest('hex'),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function discoverNamedFile(root: string, fileName: string, depth = 0): string[] {
  if (depth > MAX_DISCOVERY_DEPTH || !existsSync(root)) return [];
  const matches: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return matches;
  }
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      matches.push(entryPath);
    } else if (entry.isDirectory()) {
      matches.push(...discoverNamedFile(entryPath, fileName, depth + 1));
    }
  }
  return matches;
}

export function resolveAssistantBundlePath(studioExe = resolveStudioExe()): string {
  const override = process.env.ROBLOX_STUDIO_ASSISTANT_BUNDLE;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`ROBLOX_STUDIO_ASSISTANT_BUNDLE does not exist: ${override}`);
    }
    return override;
  }

  const exeDirectory = path.dirname(studioExe);
  const roots = [
    path.join(exeDirectory, 'BuiltInStandalonePlugins'),
    path.resolve(exeDirectory, '..', 'Resources', 'BuiltInStandalonePlugins'),
    path.resolve(exeDirectory, '..', '..', 'OTAPlugins'),
  ];
  const direct = path.join(
    exeDirectory,
    'BuiltInStandalonePlugins',
    'Optimized_Embedded_Signature',
    'Assistant.rbxm',
  );
  const candidates = new Set<string>();
  if (existsSync(direct)) candidates.add(direct);
  for (const root of roots) {
    for (const candidate of discoverNamedFile(root, 'Assistant.rbxm')) candidates.add(candidate);
  }

  const newest = [...candidates]
    .map((candidate) => ({ candidate, modifiedAt: statSync(candidate).mtimeMs }))
    .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.candidate;
  if (!newest) {
    throw new Error(
      `Studio Assistant bundle not found for ${studioExe}. ` +
      'Set ROBLOX_STUDIO_ASSISTANT_BUNDLE to the installed Assistant.rbxm path.',
    );
  }
  return newest;
}

let cachedBundle:
  | { path: string; modifiedAt: number; size: number; value: BuiltInStudioSkillsBundle }
  | undefined;

export function loadBuiltInStudioSkills(bundlePath = resolveAssistantBundlePath()): BuiltInStudioSkillsBundle {
  const stats = statSync(bundlePath);
  if (
    cachedBundle?.path === bundlePath &&
    cachedBundle.modifiedAt === stats.mtimeMs &&
    cachedBundle.size === stats.size
  ) {
    return cachedBundle.value;
  }

  const buffer = readFileSync(bundlePath);
  const skills = parseBuiltInStudioSkills(buffer);
  if (skills.length === 0) {
    throw new Error(`No built-in skill documents found in ${bundlePath}`);
  }
  const studioVersion = bundlePath
    .split(path.sep)
    .find((segment) => /^version-[a-z0-9]+$/i.test(segment));
  const value: BuiltInStudioSkillsBundle = {
    bundlePath,
    bundleModifiedAt: stats.mtime.toISOString(),
    bundleSha256: createHash('sha256').update(buffer).digest('hex'),
    studioVersion,
    skills,
  };
  cachedBundle = { path: bundlePath, modifiedAt: stats.mtimeMs, size: stats.size, value };
  return value;
}

export function findBuiltInStudioSkill(
  bundle: BuiltInStudioSkillsBundle,
  requestedName: string,
): BuiltInStudioSkill | undefined {
  const wanted = requestedName.trim().toLowerCase();
  return bundle.skills.find(
    (skill) => skill.name.toLowerCase() === wanted || skill.sourceName.toLowerCase() === wanted,
  );
}
