# A provider-neutral plain-language layer, and two repositories over one source tree

* Status: accepted
* Deciders: HCML internship project
* Date: 2026-09-18 (recorded as an ADR 2026-09-22)
* Amended: 2026-11-19: what the Assistant reads for a question goes beyond the snapshot ([ADR-0019](0019-let-the-portal-read-what-a-question-needs.md), built 18 November), and a model name ending in `-cloud` is refused while `AI_LOCAL_ONLY` is on, since a signed-in Ollama can forward such a model off the machine while the address still reads as local (SC-70); the model requests are sent with `redirect: 'error'`, so that an answer from a local address cannot send the portal on to another

## Context and Problem Statement

The portal explains problems and SLA figures in plain language, and answers questions about the
estate. Doing that means sending HCML's monitoring data (host names, trigger text, site rollups) to
a language model. HCML's source documents are stamped Private and Confidential.

Two questions, and they turned out to be one: which model, and how do you evaluate that choice
rather than assert an answer?

## Decision Drivers

* Whether estate data leaves the machine must be a deliberate, visible choice.
* The two options must be comparable (same features, same prompts, same pages) or any comparison is
  worthless.
* Maintaining two diverging codebases by hand is a known way to ship two different bugs.

## Considered Options

* Hosted model only (Anthropic API).
* Local model only (Ollama on the host).
* One provider-neutral layer, switched by configuration, deployed twice: once per backend.

## Decision Outcome

Chosen: **one provider-neutral layer (`server/src/clients/ai.ts`), switched by `AI_PROVIDER`, deployed as two
repositories that share a byte-identical source tree.**

`hcml-portal` runs hosted Claude. `hcml-portal-ollama` runs a local model on the host: the code's default for that backend is `qwen3:8b`, and `AI_MODEL` in `.env` names the one that runs (`gemma4:12b` since 18 November 2026, IN-96). `server/src` and
`web/src` are byte-identical between them: verified with `diff -rq`, not by eye. Which model
answers is a line of `.env`.

### This copy's perspective

**This is `hcml-portal`: the plain-language layer is hosted Claude over the Anthropic API.** When
someone clicks *Explain*, a problem's host name, trigger name, opdata and severity cross the
network to a third party, and its tags do not: they are free text that staff write (SC-72). The assistant sends more: the whole estate snapshot, up to ~6,200
characters covering all hosts rolled up by site, open problems with host and trigger text, and derived
SLA figures. A question that names a site or a host adds a focus block of up to 800 characters, and one that asks for more than the snapshot holds adds up to 2,800 characters more
of what it asks for: the problems of a past window, the latest values of a device, the SLA of a window, a host's state, groups and templates, WAN links, web checks, maintenance windows,
maps and summaries of the reports. Those are read on the spot, only for the pages the person holds, and up to 3,000 characters of the conversation travel with them. A model outside
this machine is not given addresses, tags, inventory, contacts or the other free text that staff write. [ADR-0019](0019-let-the-portal-read-what-a-question-needs.md) lists them, and so does
the handbook's [data in and out](../../handover/0-everyone/data-in-and-out.md).

`flow/DataFlow.pdf` draws that boundary in red, with a box reading LEAVES THIS MACHINE. In the
sibling repo the same box is green and there is no boundary at all.

**Decided 25 September 2026: this copy keeps hosted Claude.** The owner's reason: the two copies exist
to compare a hosted API model with a local one head to head, and the local side of that comparison is
`hcml-portal-ollama`. The two safeguards offered with the decision were held back at first and went in
on 7 October 2026 (tracker SC-01 and SC-09). Under every AI answer a line names Anthropic as the
external service the question was sent to. The portal shows it when the model is outside the machine's own network (`aiExternal`, SC-53),
naming Anthropic when the provider is Anthropic and an external AI service otherwise, so a local model shows nothing. Both copies limit Explain and the assistant for each signed-in user,
the same in both so the comparison stays fair: 10 calls a minute each, at most 4 hosted calls at once,
and a daily token budget for the hosted API and for a model outside the machine's network (500,000 a user, 2,000,000 in all). Each number has
an environment variable (`AI_CHAT_PER_MINUTE`, `AI_EXPLAIN_PER_MINUTE`, `AI_MAX_CONCURRENT`,
`AI_DAILY_TOKENS_PER_USER`, `AI_DAILY_TOKENS_TOTAL`) and a default, so none is required. The API key
flagged on 10 September is still to be rotated. This closes audit item FE-02 as a decision rather than
a fix.

### Positive Consequences

* The comparison is real. Both copies run the same code against the same estate, so a difference
  in answer quality or latency is a difference in the model, not in the harness.
* Switching backends is one environment variable, not a branch.
* A single bug fix lands in both, and `diff -rq` proves it did.
* The privacy question became a measurable trade rather than an argument.

### Negative Consequences

* **Two deployments to keep in step, forever.** The divergence is now 21 files and both READMEs state
  the count, so both have to be updated whenever it changes, and that count has already drifted once
  (audit finding DOC-10).
* **`AI_PROVIDER` falls back to `anthropic` for any unrecognised value, with only a warning in the
  startup log** (none at all for an empty value). A typo like `AI_PROVIDER=ollama` sends the estate
  off-box with no error and nothing in the UI. On 21 Sep the local-model
  repo's own `.env.example` was found selecting the *hosted* backend (finding B3): the exact failure
  this footgun enables.
* `@anthropic-ai/sdk` is installed in both copies and unused in one.
* Two stacks means two caches, two restarts, and twice the recompute cost of anything not persisted.
* The API key was flagged for rotation on 10 September (FE-02). The key the running hosted portal holds was
  refused by Anthropic on 16 October (401, `invalid x-api-key`), so it no longer works; replacing it is the
  owner's (SC-01).

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
* `server/src/clients/ai.ts`, `server/src/services/assistant.ts` (the entry) and the `assistant*.ts` pieces behind it
