# M0 DSH Hook Validation Design

## Goal

Resolve the host-integration assumptions in issue #1 before implementing the
MDT guard. Determine what can be verified from authoritative, publicly
accessible DSH sources and clearly separate that evidence from checks that
require the hospital's actual deployment.

## Scope

This work addresses only M0 issue #1:

- DSH plugin registration/loading and profile installation path.
- `agent/pre-step` waterfall behavior and `{ kind: 'reject' }` semantics.
- Whether a rejected turn avoids the upstream model call.
- How a fixed refusal can be shown without representing it as model output.
- Differences relevant to the stated `0.2.1-rc.3` compatibility baseline and
  the PRD's reported `0.2.1-rc.5` API confirmation.
- Web/server-side and desktop deployment boundaries, to the extent publicly
  documented.

It does not implement a production plugin, change DSH or
`dsh-plugin-hzhospital`, claim hospital deployment compatibility, or verify
real hospital UI/model behavior.

## Approach

Use publicly accessible authoritative DSH source, release artifacts, and
documentation as the evidence source. Record source URLs, versions, and the
specific behavior each source supports. If a detail cannot be established
from those sources, label it as unverified and carry it forward as a hospital
environment check rather than inferring behavior from the PRD.

When sources disagree, prefer the tagged source/release artifact for the
specific version under review, then versioned documentation, then current
unversioned documentation. Record the disagreement rather than silently
resolving it.

Do not add a mock test merely to assert guessed host APIs. If the official
source establishes a stable, meaningful contract that can be represented
locally, add a small isolated contract test; otherwise the issue deliverable
is a reproducible verification report and test procedure.

## Deliverables

- A validation report at
  `Docs/M0-plugin-hook-validation.md` that records sources, versions, findings,
  reproducible steps, and unresolved checks.
- A clear compatibility conclusion for rc.3 and rc.5, limited to behaviors
  actually supported by evidence.
- A documented refusal-rendering recommendation based on verified host
  behavior; if neither host-side message insertion nor blocked-turn rendering
  is established, mark the choice as unresolved.
- A concrete hospital follow-up checklist for server-side enforcement,
  blocked-turn visibility, and proof that a rejected request does not reach
  the upstream model.

## Verification

- Re-run every source inspection or local procedure described in the report
  and record the commands/steps and observed outcome.
- Ensure every positive compatibility statement has a source or a reproducible
  local observation.
- Ensure mock/local checks are not presented as evidence of hospital
  deployment behavior.
- Review the working tree and report to ensure no credentials, patient data,
  or private endpoint values were introduced.

## Risks and handling

- Public upstream sources may not expose private hospital deployment details.
  Keep those items explicitly blocked for the hospital follow-up.
- The PRD's rc.3 and rc.5 statements may not match the accessible upstream
  artifacts. Report any mismatch and avoid silently selecting the more
  favorable version.
- A rejected pre-step may stop model generation without providing a supported
  way to render a fixed assistant-side refusal. Do not work around this by
  fabricating a model response; identify the supported UI integration or
  leave the rendering decision open.
