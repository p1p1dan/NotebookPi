# Proposal Truth Source

The proposal.json file is the authoritative source for proposal stage and lifecycle.
Session runtime files (runtime/sessions/*.json) are hints only and must NEVER
override or contradict proposal.json values.

When injecting context, always read stage and item status from proposal.json and
execution.json respectively — never from session runtime data.
