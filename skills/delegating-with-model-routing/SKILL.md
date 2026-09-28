---
name: delegating-with-model-routing
description: Use when delegating work to a subagent in DeepSeek Harness, especially when the task is mechanical, or when a task is hard enough that a stronger model is worth the cost. Explains how to pick the right model instead of always using the default.
whenToUse: Before calling the `subagent` tool, and when deciding whether a task deserves the strongest available model or a cheap fast one.
---

# Delegating with model routing

## What routing gives you

When model routing is enabled, the `subagent` tool accepts three extra parameters:

| Parameter | Meaning |
|---|---|
| `provider` | which provider route to use |
| `model` | which model on that provider |
| `reasoning_effort` | only for models that expose effort levels |

A companion tool, **`list_subagent_models`**, reports the routes currently
available. Call it when you do not already know them.

`provider` and `model` are supplied **together**, or not at all. Supplying only one
is not a valid route.

## First: check whether routing is on

**If the parameters are absent from the `subagent` schema, routing is disabled** —
not broken. `subagent` then takes only `description`, `prompt`, and
`run_in_background`, and every child runs on the parent's model.

That is a Host setting, not something you can change from a tool call. When it is
off, delegate normally and do not pretend you chose a model. Telling the user you
routed work when the parameter does not exist is worse than not routing.

## How to choose

Route by what the task **demands**. The failure modes are symmetric: sending hard
work to a weak model produces a confidently wrong answer, and sending trivial work
to the strongest model wastes money and time for no gain.

**Send to a fast, cheap route:**
- mechanical, fully specified edits — renames, import fixes, format conversions
- repeating one understood transformation across many files
- summarizing or extracting from material you have already read
- generating boilerplate from a template
- anything where "correct" is checkable at a glance

**Send to the strongest reasoner, with high effort:**
- design under conflicting constraints, where the tradeoff *is* the deliverable
- debugging a failure whose cause is not yet known
- anything touching concurrency, security, money, or migrations
- reviewing code for subtle problems
- a question the user asked because they could not answer it themselves

**Do not** send a reading-and-reporting task to a reasoning-heavy route. The work
is I/O, not thinking, and effort buys nothing.

## The rule that matters most

**Never downgrade a hard task to save tokens.** A cheap model that answers a hard
question wrongly costs far more than the tokens saved, because the error is
plausible and may not be caught. If you are unsure how hard a task is, start with
the default route — do not guess downward.

The reverse mistake is milder: using the strongest model for a mechanical edit is
wasteful, not dangerous.

## When the child comes back

A delegated result carries no authority of its own. If a child reports that a file
was edited, a test passed, or a command succeeded, that is a claim — verify it
before repeating it as fact. This matters more with a weaker model on a mechanical
task, which is exactly the configuration where routing is most tempting.

## Practical notes

- A route that does not resolve wastes the entire call. Prefer a route you have
  seen in `list_subagent_models` over one you inferred from a model name.
- The available routes are a permission list, not a catalogue of everything the
  provider sells. A model can exist and still not be offered to you.
- Routing decisions are recorded per session. Changing the setting later does not
  retroactively change sessions that already recorded a policy.
