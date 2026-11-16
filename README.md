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

Signatures from [`terrorlua/obfuscator-samples`](https://github.com/terrorlua/obfuscator-samples)
are also used for *detection only* (`lib/profiles/family.js`). When an input
belongs to a family without a deobfuscator (Hercules, MoonSec, SynapseXen, PSU,
Ironbrew, Boronide, 77fuscator, LuaObfuscator, …), the API names the family in
the error instead of replying "unknown format".

## Vendored engines

Both third-party engines are MIT and vendored under `engines/`. The Luraph copy
is unmodified; the Prometheus copy carries a three-line fix for undefined
constants in `src/beautify/jumps.js` (see Known limits).

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

- **Luraph**: verified on two upstream samples (~280 KB each) whose output is
  byte-identical to the reference files. A 1.5 MB sample did not finish inside a
  5-minute local run, so large inputs need a longer job timeout
  (`LURAPH` timeout is 6 min by default) and enough RAM.
- **Luraph v14.x** is detected and rejected with an explicit message. The
  community v14 engine from `DiscordDeobBot-VIP-Smart-Deob.zip` was tested
  against two real v14.7 samples from `terrorlua/obfuscator-samples` (181 KB and
  1.2 MB). It reported `0 functions` captured in every devirtualization round:
  the 1.2 MB sample only returned an intercepted `loadstring()` chunk that is
  still VM bytecode, and the 181 KB sample failed with a runtime error. A second
  pass over the recovered chunk failed too. The engine is therefore **not**
  vendored — returning that output as "deobfuscated" would be misleading. Only
  v15 / v15.1 are enabled.
- **Prometheus**: verified on three real corpus samples (Strong, Weak and
  WeAreDevs). The upstream formatter shipped three undefined constants
  (`TAIL_STATEMENTS`, `TAIL_NODES`, `LEAVING_KINDS`) which made the `09-fmt` step
  throw on labelled payloads and leave a dangling `local` in the output. They
  are patched in `engines/prometheus/src/beautify/jumps.js`, and
  `lib/profiles/prometheus.js` strips any remaining empty declaration as a
  safety net. The Weak sample still emits `unstructured-loop` warnings from the
  VM lifter, but its output parses as valid Lua.
- Job state is in memory: a restart drops queued or finished jobs.
