import {
  applyExecuteLuauOutputLimit,
  EXECUTE_LUAU_DEFAULT_OUTPUT_BYTES,
  EXECUTE_LUAU_MAX_OUTPUT_BYTES,
  HTTP_BODY_LIMIT_BYTES,
  resolveExecuteLuauOutputLimit,
  truncateUtf8,
} from '../http-body-limits.js';

describe('field #5 execute_luau output budget', () => {
  test('default and upper bound follow the HTTP body limit', () => {
    expect(resolveExecuteLuauOutputLimit(undefined)).toBe(EXECUTE_LUAU_DEFAULT_OUTPUT_BYTES);
    expect(EXECUTE_LUAU_MAX_OUTPUT_BYTES).toBe(HTTP_BODY_LIMIT_BYTES);
    expect(resolveExecuteLuauOutputLimit(HTTP_BODY_LIMIT_BYTES)).toBe(HTTP_BODY_LIMIT_BYTES);
    expect(() => resolveExecuteLuauOutputLimit(HTTP_BODY_LIMIT_BYTES + 1)).toThrow('HTTP body limit');
    for (const bad of [0, -1, 1.5, '100', NaN]) {
      expect(() => resolveExecuteLuauOutputLimit(bad)).toThrow('positive integer');
    }
  });

  test('marks a return value above the budget as truncated with byte accounting', () => {
    const returnValue = 'x'.repeat(200_000);
    const result = applyExecuteLuauOutputLimit({ success: true, returnValue, output: [] }, 1000);
    expect(result).toMatchObject({ success: true, truncated: true, totalBytes: 200_000, returnedBytes: 1000, maxOutputBytes: 1000 });
    expect(result.returnValue).toBe('x'.repeat(1000));
    expect(result.outputTruncated).toBeUndefined();
  });

  test('keeps a return value within the budget intact and reports truncated:false', () => {
    const returnValue = 'y'.repeat(200_000);
    const result = applyExecuteLuauOutputLimit({ success: true, returnValue }, 300_000);
    expect(result).toMatchObject({ truncated: false, totalBytes: 200_000, returnedBytes: 200_000, maxOutputBytes: 300_000 });
    expect(result.returnValue).toBe(returnValue);
    const none = applyExecuteLuauOutputLimit({ success: false, error: 'boom' }, 10);
    expect(none).toMatchObject({ success: false, error: 'boom', truncated: false, totalBytes: 0, returnedBytes: 0 });
  });

  test('cuts on a UTF-8 boundary so multibyte characters are never split', () => {
    // 2-byte (Latin), 3-byte (euro sign) and 4-byte (emoji) sequences.
    const text = 'aé€\u{1F600}b';
    expect(Buffer.byteLength(text)).toBe(11);
    expect(truncateUtf8(text, 2)).toBe('a');
    expect(truncateUtf8(text, 3)).toBe('aé');
    expect(truncateUtf8(text, 5)).toBe('aé');
    expect(truncateUtf8(text, 6)).toBe('aé€');
    expect(truncateUtf8(text, 9)).toBe('aé€');
    expect(truncateUtf8(text, 10)).toBe('aé€\u{1F600}');
    const result = applyExecuteLuauOutputLimit({ returnValue: text }, 3);
    expect(result).toMatchObject({ truncated: true, totalBytes: 11, returnedBytes: 3 });
    expect(result.returnValue).toBe('aé');
  });

  test('print output shares the budget and is truncated by whole lines', () => {
    const output = Array.from({ length: 50 }, () => 'p'.repeat(1000));
    const result = applyExecuteLuauOutputLimit({ success: true, returnValue: 'done', output }, 5000);
    expect(result).toMatchObject({ truncated: false, totalBytes: 4, returnedBytes: 4, outputTruncated: true, outputTotalBytes: 50_049, outputReturnedBytes: 4003 });
    expect(result.output).toEqual(output.slice(0, 4));
    const small = applyExecuteLuauOutputLimit({ success: true, output: ['a', 'b'] }, 5000);
    expect(small.outputTruncated).toBeUndefined();
    expect(small.output).toEqual(['a', 'b']);
  });
});
