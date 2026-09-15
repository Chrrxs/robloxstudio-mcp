# 00 — Field regression list (behaviors that must keep working)

Command: `node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/00-field-regressions.mjs` (2026-09-15, on top of `dddd037`; managed baseplate while three unrelated Studio instances were open)

Raw output:
```
{"grepMs":16,"matches":50}
{"soloPlaytestStartMs":3095}
{"evalServerA":{"ok":true,"bridge":"ok","result":"1","output":[]},"evalServerB":{"ok":true,"bridge":"ok","result":"2","output":[]}}
{"evalClient":{"ok":true,"bridge":"ok","result":"<user>","output":[]}}
{"exported":{"bytes_written":7043,"instance_count":1,"output_path":"C:\\Users\\<user>\\AppData\\Local\\Temp\\field0-sQlDh7\\fixture.rbxm"}}
{"soloPlaytestStopMs":1616}
✅ field regression list PASSED
```
Thresholds: grep_scripts < 5 s (measured 16 ms over 50 scripts), solo_playtest start ≤ 15 s (3.1 s), stop 1.6 s, require cache 1 → 2, export_rbxm read 7,043 B from the edit DataModel during play.
The localhost-HTTP behavior (`HttpService:GetAsync("http://127.0.0.1:…")` from `execute_luau`) is covered by test 05.
