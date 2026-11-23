# mend: one patch tool for every AI edit format

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/firehorse20/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/firehorse20/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats, and
`mend` reads all four to one written specification, `SPEC.md` — the whole contract. Every file is changed or nothing
is.

## The four formats

- **Unified diffs** — `diff --git` sections and bare `---`/`+++` pairs, with hunks whose line numbers are often
  wrong: hunks are matched by content, taking the occurrence nearest the stated line, and `\ No newline at end of
  file` decides the final line break. Creations, deletions and renames (including `rename from`/`rename to`) are
  one edit each.
- **SEARCH/REPLACE blocks** — a path line, `<<<<<<< SEARCH`, old lines, `=======`, new lines, `>>>>>>> REPLACE`.
  The old lines must occur exactly once at their tier, or the block fails `ambiguous`; an empty old block creates
  the file.
- **V4A patches** — `*** Begin Patch` … `*** End Patch`, with `Add File`, `Delete File` and `Update File` sections,
  `@@` anchors, `*** Move to:` and `*** End of File` chunks, applied in order with a cursor that moves past what
  each chunk wrote.
- **JSON tool calls** — one JSON array of edit objects, or one edit object per line: `create`, `str_replace`
  (exact, exactly once) and `insert` (by line number), with CRLF files read and written back as CRLF.

## Matching

Old lines are found at the first of three tiers where they occur at least once: tier 0, every line equal; tier 1,
every line equal once trailing spaces and tabs are removed; tier 2, every line equal once leading and trailing
spaces and tabs are removed. `--strict` tries tier 0 only. At tier 2, new lines are re-indented from the old
lines' indentation to the file's own, while context lines are always written as the file's own matched lines.

## Invocation

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`--format` is `auto` (the default), `unified`, `search-replace`, `v4a` or `json`; `--check` does everything but
write; `--strict` matches exactly. PATCH is a path, or `-`/absent for standard input. Exit 2 is a usage, missing
patch, format or parse error; exit 1 lists every failed edit and `failed: <k> of <n> edits`; exit 0 lists the
changed paths (`A`, `D`, `M`, or `R <old> -> <new>` for a move) and `ok: <n> files`. Paths must be safe (no
absolute paths, no `\`, no empty/`.`/`..` segments); directories are created as files need them.

## Practice results

- The 100 public practice checks: **100 of 100 passed, practice score 1000** (`node check.ts
  program/generator/practice.json`).
- The 3 public practice trials (100 checks each, run through the real trial runner): **100 of 100 on each,
  score 1000**, and trial 0 replayed byte-identical.

The scored checks are drawn after the deadline from a sealed pool that includes kinds the practice set does not
show, each testing a sentence of `SPEC.md` — so the implementation follows the specification generally, not the
practice patterns.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines hand a trial over to `runner.ts`
  when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's trial runner, kept as it is.
- `check.ts`: the practice set on your own machine.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.
