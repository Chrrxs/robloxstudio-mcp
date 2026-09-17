// A failed child invalidates the shared Studio session: never launch another
// test or wait an inter-test delay after that failure. Launch errors are failed
// attempts, with their original error retained for the caller's summary.
export async function runSequentialSuite(files, { run, betweenTests }) {
  const results = [];
  for (const file of files) {
    if (results.length > 0) await betweenTests();
    let result;
    try {
      result = { file, code: await run(file) };
    } catch (error) {
      result = { file, code: 1, error };
    }
    results.push(result);
    if (result.code !== 0) break;
  }
  return { results, skipped: files.slice(results.length) };
}
