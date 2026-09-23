# A provider-neutral plain-language layer, and two repositories over one source tree

* Status: accepted
* Deciders: HCML internship project
* Date: 2026-09-18 (recorded as an ADR 2026-09-22)

## Context and Problem Statement

The portal explains problems and SLA figures in plain language, and answers questions about the
estate. Doing that means sending HCML's monitoring data (host names, trigger text, site rollups) to
a language model. HCML's source documents are stamped Private and Confidential.

Two questions, and they turned out to be one: which model, and how do you evaluate that choice
honestly rather than asserting an answer?

## Decision Drivers

* Whether estate data leaves the machine must be a deliberate, visible choice.
* The two options must be comparable (same features, same prompts, same pages) or any comparison is
  worthless.
* Maintaining two diverging codebases by hand is a known way to ship two different bugs.

## Considered Options

* **Hosted model only** (Anthropic API).
* **Local model only** (Ollama on the host).
* **One provider-neutral layer, switched by configuration, deployed twice**: once per backend.

## Decision Outcome

Chosen: **one provider-neutral layer (`server/src/ai.ts`), switched by `AI_PROVIDER`, deployed as two
repositories that share a byte-identical source tree.**

`hcml-portal` runs hosted Claude. `hcml-portal-ollama` runs `qwen3:8b` on the host. **`server/src` and
`web/src` are byte-identical between them**: verified with `diff -rq`, not by eye. Which model
answers is a line of `.env`.

### This copy's perspective

**This is `hcml-portal`: the plain-language layer is hosted Claude over the Anthropic API.** When
someone clicks *Explain*, a problem's host name, trigger name, opdata, severity and tags cross the
network to a third party. The assistant sends more: the whole estate snapshot, up to ~5,500
characters covering all hosts rolled up by site, open problems with host and trigger text, and derived
SLA figures.

`flow/DataFlow.pdf` draws that boundary in red, with a box reading **LEAVES THIS MACHINE**. In the
sibling repo the same box is green and there is no boundary at all.

### Positive Consequences

* **The comparison is real.** Both copies run the same code against the same estate, so a difference
  in answer quality or latency is a difference in the model, not in the harness.
* Switching backends is one environment variable, not a branch.
* A single bug fix lands in both, and `diff -rq` proves it did.
* The privacy question became a measurable trade rather than an argument.

### Negative Consequences

* **Two deployments to keep in step, forever.** The divergence is now 21 files and both READMEs state
  the count, so both have to be updated whenever it changes, and that count has already drifted once
  (audit finding DOC-10).
* **`AI_PROVIDER` falls back to `anthropic` silently for any unrecognised value.** A typo like
  `AI_PROVIDER=ollama` sends the estate off-box with no error anywhere. On 21 Sep the local-model
  repo's own `.env.example` was found selecting the *hosted* backend (finding B3): the exact failure
  this footgun enables.
* `@anthropic-ai/sdk` is installed in both copies and unused in one.
* Two stacks means two caches, two restarts, and twice the recompute cost of anything not persisted.
* The API key has been flagged for rotation since 10 September and **has still not been rotated**
  (FE-02).

## Pros and Cons of the Options

### Hosted model only

* Good, because answer quality is high and there is nothing to run.
* Bad, because every Explain sends production estate data to a third party, with no local alternative
  to compare against.

### Local model only

* Good, because nothing leaves the machine.
* Bad, because it is materially slower. Measured 18 Sep: first token 9.7 s cold against 1.3 s hosted,
  and it needs a model runtime maintained on the host.
* Bad, because with no hosted comparison there is no way to say what the privacy is costing.

### Provider-neutral, deployed twice

* Good, because it answers both the product question and the evaluation question at once.
* Bad, because it is the only option that creates a permanent two-deployment maintenance burden.

## Links

* Follows [ADR-0002](0002-react-typescript-fastify.md)
* `setup.md` §13 *Plain-language layer*, §24 *Assistant*
* `flow/DataFlow.pdf`: the trust boundary, drawn per copy
* `server/src/ai.ts`, `server/src/chat.ts`
