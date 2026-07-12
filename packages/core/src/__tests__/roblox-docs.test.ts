import { extractSection, getRobloxDoc, listSections, isDocCategory, docUrl } from '../roblox-docs.js';

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

  test('an unresolved lookup returns ranked recommendations from the official engine index', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ status: 404, ok: false } as Response)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => [
          'reference/engine/classes/Camera',
          'reference/engine/classes/ProximityPrompt',
          'reference/engine/datatypes/CFrame',
          'reference/engine/enums/KeyCode',
        ].join('\n'),
      } as Response);

    try {
      const result = await getRobloxDoc('classes', 'ProximtyPrompt');

      expect(result.recommendations?.[0]).toMatchObject({
        category: 'classes',
        name: 'ProximityPrompt',
      });
      expect(result.content).toContain('No exact Roblox documentation page found');
      expect(result.content).toContain('classes/ProximityPrompt');
      expect(result.content).toContain('datatypes/CFrame');
    } finally {
      fetchMock.mockRestore();
    }
  });
});
