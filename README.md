# ANTILUA DEOBFUSCATOR

Multi-engine Luau / Lua deobfuscator. Paste or drop a protected script, pick an
engine (or let it auto-detect), and get readable source back. Every result file
starts with `-- Deobfuscated By ANTILUA DEOBFUSCATOR`.

## Engines

| Engine | Target | How it works | Runtime |
|---|---|---|---|
| **Luraph v15 / v15.1** | Luraph VM | Traces the script in an offline Luau sandbox, decrypts constants live, devirtualizes the bytecode and lifts control flow | minutes (job) |
| **Prometheus** | Prometheus VM | Unwraps layers, folds constants, decrypts strings, lifts the VM | seconds |
| **NXS9 / StudioDev57** | string table + base85 + stream cipher | Recovers the cipher constants from the build, decrypts, inlines, folds, renames | ~1 s |
| **Norev dispatcher** | string table + chained XOR + method binder | Derives the key slot and cipher mapping from the data, inlines, unwraps `o:M(...)` | ~1 s |
| **Constant-only** | mangled names + `((a+b)-b)` | Folds constants and renames identifiers; refuses input that does not look obfuscated | ~1 s |

Luraph is the only engine that cannot answer inside a request: a real sample
needs a few minutes of tracing. `POST /api/deobfuscate` returns `202` with a
`jobId`, and the client polls `GET /api/jobs/:id`. Everything else answers in
the same request.

## Vendored engines

Both third-party engines are MIT and kept unmodified under `engines/`:

- `engines/luraph/` — [ServerDeadd/Luraph-v15.1-Deobfuscator](https://github.com/ServerDeadd/Luraph-v15.1-Deobfuscator)
  (Node driver + Python core + Luau binaries). The Linux CLI is stored as
  `bin/luau-linux` because `luau` and `luau.exe` cannot coexist on a
  case-insensitive filesystem; the Dockerfile renames it at build time.
- `engines/prometheus/` — [Prometheus-Deobfuscator](https://github.com/prostone4/Prometheus-Deobfuscator) (pure JS).

Their licences are kept next to the code.

## API

```
POST /api/deobfuscate   { source, engine? }        -> result | { queued, jobId }
GET  /api/jobs/:id                                 -> { status, log, result }
GET  /api/engines                                  -> engine list + availability
GET  /api/health                                   -> uptime, engines, job stats
```

`engine` accepts `auto` (default), `luraph`, `prometheus`, `studiodev57`,
`dispatcher`, `plain`.

## Local

```bash
npm start            # http://127.0.0.1:3000
npm run test:all     # cipher sweep + guard + routing + syntax
```

Luraph needs Python 3.10+ and `engines/luraph/bin/luau(.exe)`; both ship with the
repo, and `/api/health` reports whether the engine is ready. Set `PYTHON_BIN` if
`python` is not on PATH.

## Deploy (Railway)

`railway.json` points at the `Dockerfile`, which installs `python3` and makes the
Luraph binaries executable. Nothing else to configure — the port comes from
`$PORT`, the healthcheck is `/api/health`.

## Known limits

- **Luraph v14.x** is detected but not handled: the vendored engine only
  registers its v15 plugin, and the v14 pipeline in that repo is incomplete.
  A v14 sample is needed before adding it.
- **Prometheus** is wired end to end, but no real Prometheus sample was
  available while building this, so the engine has only been checked against
  false positives — not against a successful decode.
- Job state is in memory: a restart drops queued or finished jobs.
