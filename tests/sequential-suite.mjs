#!/usr/bin/env node

import assert from 'node:assert/strict';
import { runSequentialSuite } from './lib/sequential-suite.mjs';

const files = ['first.mjs', 'middle.mjs', 'last.mjs'];

{
  const events = [];
  const suite = await runSequentialSuite(files, {
    run: async (file) => {
      events.push(file);
      return 1;
    },
    betweenTests: async () => events.push('delay'),
  });
  assert.deepEqual(events, ['first.mjs']);
  assert.deepEqual(suite, {
    results: [{ file: 'first.mjs', code: 1 }],
    skipped: ['middle.mjs', 'last.mjs'],
  });
}

{
  const events = [];
  const suite = await runSequentialSuite(files, {
    run: async (file) => {
      events.push(file);
      return file === 'middle.mjs' ? 2 : 0;
    },
    betweenTests: async () => events.push('delay'),
  });
  assert.deepEqual(events, ['first.mjs', 'delay', 'middle.mjs']);
  assert.deepEqual(suite, {
    results: [{ file: 'first.mjs', code: 0 }, { file: 'middle.mjs', code: 2 }],
    skipped: ['last.mjs'],
  });
}

{
  const events = [];
  const suite = await runSequentialSuite(files, {
    run: async (file) => {
      events.push(file);
      return 0;
    },
    betweenTests: async () => events.push('delay'),
  });
  assert.deepEqual(events, ['first.mjs', 'delay', 'middle.mjs', 'delay', 'last.mjs']);
  assert.deepEqual(suite, {
    results: files.map((file) => ({ file, code: 0 })),
    skipped: [],
  });
}

// spawn may throw synchronously or reject through the child's error event.
for (const rejectAsynchronously of [false, true]) {
  const events = [];
  const error = new Error('Child launch failed');
  const suite = await runSequentialSuite(files, {
    run: (file) => {
      events.push(file);
      if (file === 'first.mjs') return 0;
      if (rejectAsynchronously) return Promise.reject(error);
      throw error;
    },
    betweenTests: async () => events.push('delay'),
  });
  assert.deepEqual(events, ['first.mjs', 'delay', 'middle.mjs']);
  assert.deepEqual(suite, {
    results: [{ file: 'first.mjs', code: 0 }, { file: 'middle.mjs', code: 1, error }],
    skipped: ['last.mjs'],
  });
}

console.log('Sequential suite fail-fast regressions passed');
