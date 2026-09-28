---
name: editing-files-in-dsh
description: Use when editing or writing files in DeepSeek Harness, especially the first edit to a file you have not opened this session. Prevents the two most common avoidable file-tool failures measured on this machine — editing a file that was never read, and editing a target whose content changed underneath you.
whenToUse: Before calling `edit` or `write` on a file; and immediately after a file-tool error, to recover in one step instead of retrying blindly.
---

# Editing files in DeepSeek Harness

## Why this file exists

Measured across 586 stored sessions, 1,044 tool failures. Two file-editing
mistakes accounted for the avoidable ones, and both cost **round trips**, not just
tokens — each failure means the model was told "no", then had to try again.

| Failure | Events | Shape |
|---|---|---|
| `FS_NOT_OBSERVED` — modify without reading | **87** in 22 sessions | `62× edit`, `23× write` |
| `FS_STALE_VERSION` — content changed under you | **36** | file changed since read |
| `FS_EDIT_NOT_FOUND` — `old_string` did not match | **29** | anchor text wrong |

The worst single session hit `FS_NOT_OBSERVED` **25 times on one file** and never
recovered. Another tried **16 different files** and read none of them afterwards.
The failure does not self-correct: once the tool says "no", the model tends to
retry the same shape of call.

## Rule 1 — read before you write, every session

The harness enforces this. `edit` and `write` on a file this session has not
observed are **refused** with:

```
Error: cannot modify "<path>": file has not been read — read the file, then retry
```

This is not a permission problem and not a sandbox problem. Re-running the same
edit will fail identically. **The fix is one `read`.**

- About to `edit` a file you have not opened this session → `read` it first.
- About to `write` a file that already exists → `read` it first, even when you
  intend to replace all of its content.
- `write` a **new** file needs no read, because there is nothing to observe.
- The rule is per session. A file read in an earlier conversation is not observed
  in this one.

Do not guess at a file's contents and edit it anyway. If you believe you know what
is in it, that belief is exactly what `read` costs one call to confirm — against a
guaranteed failure and a retry.

## Rule 2 — read again after anything else may have changed the file

`FS_STALE_VERSION` means the file moved since you read it:

```
Error: cannot edit "<path>": file changed since it was read — re-read the file, then retry
```

Treat a stale version as information, not obstruction. The usual causes, all
common in real work:

- you ran a formatter, a code generator, or a build that rewrote the file;
- a `git` operation changed it (`checkout`, `stash`, `pull`, `reset`);
- **another agent or teammate wrote to it** — shared workspaces make this routine;
- your own earlier `write` replaced the whole file, so every offset you planned
  against is now wrong.

Re-read, then apply the edit to what is actually there. Do not retry the identical
call: the content is different, so the same `old_string` may no longer exist or may
now match somewhere unintended.

## Rule 3 — pick an anchor that can only match once

`FS_EDIT_NOT_FOUND` means `old_string` was not found. The causes, in the order
worth checking:

1. **Whitespace or indentation differs.** The text is there but not byte-identical.
   Re-read the region and copy the anchor from the file.
2. **You are editing from memory.** The most common cause. Your recollection of the
   line is close, not exact.
3. **The text was already changed** by an earlier edit in this same session.

Include enough surrounding context that the anchor is unambiguous, but not so much
that any unrelated later change invalidates it. If a tool reports a **multiple
matches** error, the anchor is too short — extend it until it is unique.

## Rule 4 — when a file tool refuses, read; do not retry

The single highest-value habit in this file. A refusal is the tool telling you which
precondition you missed. The correct response is always to satisfy it:

| Error | Correct response |
|---|---|
| `FS_NOT_OBSERVED` | `read` the file, then re-apply the edit |
| `FS_STALE_VERSION` | `read` the file again, then re-apply |
| `FS_EDIT_NOT_FOUND` | `read` the region, copy the anchor exactly, retry |
| ambiguity / multiple matches | extend the anchor until unique |
| `FS_NOT_FOUND` | the path is wrong — list the parent directory and confirm the real name |

Re-issuing an identical failing call is the one response guaranteed not to work.
If two attempts fail the same way, stop and inspect: print the surrounding lines,
list the directory, or check whether another process is writing the file.

## What this is not

- It is **not** a reason to avoid editing. Editing is the job.
- It is **not** a claim that the guards are too strict. Each one caught a real
  mistake that would otherwise have silently written the wrong content — a
  mangled edit that succeeds is worse than one that fails.
- The counts above are from **one machine's history**, not a benchmark. They show
  which mistakes actually happen here; they are not a general failure rate.
