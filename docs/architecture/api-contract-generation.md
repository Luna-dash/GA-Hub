# API Contract Generation

## Current contract slice

The checked-in [`openapi.json`](../api/openapi.json) is generated from the configured FastAPI application and is the route/method contract used by the frontend. It prevents these failures:

- the frontend calls a route the backend removed;
- the frontend uses a method the backend no longer exposes;
- a route parameter is accidentally dropped or added to a call URL.

Regenerate it after changing backend routes:

```powershell
D:/APP/anaconda3/envs/ga/python.exe scripts/export_openapi.py
```

Check every `api.client` HTTP call against the artifact:

```powershell
npm run api:check
```

Run this from `webui`, or use `npm --prefix webui run api:check` from the repository root.

`tests/test_api_contract.py` additionally fails if the checked-in artifact no longer
matches the running FastAPI app. This catches a forgotten regeneration even before
the frontend checker runs.

## Why the checker parses TypeScript instead of regexes

`webui/scripts/check-api-contract.mjs` uses the TypeScript compiler API to find every direct `http(...)` call. Template parameters become wildcard path segments and query strings are ignored at this stage. That keeps the check robust across formatting and multi-line calls.

The checker understands one frontend template pattern where a dynamic path segment is optional. This is temporary compatibility for `conductorReadme`; new client methods must use distinct static or fully parameterized routes.

The checker intentionally does not rewrite the hand-written client yet. It is the first independent gate in a staged migration:

1. FastAPI OpenAPI becomes the durable route/method source of truth.
2. High-value endpoints gain explicit Pydantic response models.
3. Generated TypeScript request/response types replace the corresponding hand-written aliases.
4. The checker is tightened from route/method matching to payload/type matching.

WebSocket messages, generated download URLs, and `fetch` calls outside `http()` are not covered yet. Add them only after their backend schemas are explicit; duplicating undocumented hand-written shapes would provide false confidence.
