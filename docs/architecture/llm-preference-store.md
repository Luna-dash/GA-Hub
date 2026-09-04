# Preferred LLM ownership boundary

`LlmPreferenceStore` owns the preferred-LLM semantics. `preferred_llm_key`
is the durable truth; `preferred_llm_no` survives only as a derived value
for older callers:

- It reads the fields from config.json once and caches the key, the derived index and the no-preference state.
- It preserves unrelated config.json fields when writing.
- It skips redundant writes when the cached or persisted value already matches.
- It does not become the owner of the whole config.json.

`AgentService` remains the GA runtime facade. It coordinates restoring the preferred LLM at construction, applying explicit user switches, and restoring preference after transient per-task LLM selection. Session runtimes can read the preference without treating it as session-local state.
