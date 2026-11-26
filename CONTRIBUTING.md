# Contributing

Skip a test only via `skipIf(cond, tag, why)` / `skipBecause(tag, why)` from `test/helpers-skip.mjs`, with a tag allowed on that OS there (add a new tag to its OS table if needed); never a bare `t.skip`/`{ skip: true }` — CI fails untagged skips, and there is no skip count to raise.
