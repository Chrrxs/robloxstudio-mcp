import { extractSection, listSections, isDocCategory, docUrl } from '../roblox-docs.js';

const SAMPLE = [
  '# Class: ProximityPrompt',
  '',
  '> Summary line.',
  '',
  '## Description',
  '',
  'The **ProximityPrompt** instance lets you prompt players.',
  '',
  '## Properties',
  '',
  '### ActionText',
  '',
  'Action shown to the player.',
  '',
  '## Events',
  '',
  'Triggered when things happen.',
].join('\n');

describe('roblox-docs markdown helpers', () => {
  test('listSections returns ##-level headings only', () => {
    expect(listSections(SAMPLE)).toEqual(['Description', 'Properties', 'Events']);
  });

  test('extractSection returns one section up to the next heading', () => {
    const section = extractSection(SAMPLE, 'Description');
    expect(section).toContain('## Description');
    expect(section).toContain('lets you prompt players');
    expect(section).not.toContain('## Properties');
  });

  test('extractSection keeps ###-level subsections inside their parent', () => {
    const section = extractSection(SAMPLE, 'properties');
    expect(section).toContain('### ActionText');
    expect(section).not.toContain('## Events');
  });

  test('extractSection returns undefined for a missing section', () => {
    expect(extractSection(SAMPLE, 'Methods')).toBeUndefined();
  });

  test('isDocCategory accepts known categories and rejects others', () => {
    expect(isDocCategory('classes')).toBe(true);
    expect(isDocCategory('enums')).toBe(true);
    expect(isDocCategory('bogus')).toBe(false);
  });

  test('docUrl builds the create.roblox.com markdown URL', () => {
    expect(docUrl('classes', 'ProximityPrompt'))
      .toBe('https://create.roblox.com/docs/reference/engine/classes/ProximityPrompt.md');
  });
});
