'use strict';

const fs = require('fs');
const path = require('path');
const vmmap = require('./vmmap');
const harness = require('./harness');
const trace = require('./traceout');
const tidy = require('./tidy');

const SPIN_CHECKS = 24;

function patchChunk(src, tmpdir, chunkTag) {
  const p = path.join(tmpdir, `_chunk_${harness.chunkKey(src)}.luau`);
  fs.writeFileSync(p, src, 'latin1');
  try {
    return vmmap.patchEntries(src, p, chunkTag);
  } catch (e) {
    process.stderr.write(`[!] could not instrument chunk (${e.message})\n`);
    return src;
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
}

/**
 * Decide whether a devirtualized lift is usable.
 *
 * A `(nil)(` count alone is not enough. A real report showed a 12-line stub
 * being accepted as "devirtualized source":
 *
 *     local v = ...
 *     upv1 = v
 *     local v2 = upv2
 *     if nil then n = 1 ... else n = 1 end
 *     upv2 = v2 + n
 *
 * No `(nil)(` anywhere, so the old rule passed it, yet it cannot be the
 * program: `if nil then` can never run, the two branches assign the same
 * value, and the upvalues the VM reads are written as globals. Those are
 * structural tells and are checked directly.
 */
function judgeLift(lifted, opts = {}) {
  const sourceBytes = opts.sourceBytes || 0;
  const lines = lifted.split('\n').length;
  const stmts = (lifted.match(/[;{}]|\b(?:local|function|end|return|if|for|while)\b/g) || []).length;
  const nilCalls = (lifted.match(/\(nil\)\(/g) || []).length;
  const bytes = Buffer.byteLength(lifted, 'utf8');
  const problems = [];

  // 1. Unresolved VM calls, as before.
  if (nilCalls >= 50 && nilCalls * 100 >= lines) {
    problems.push(`${nilCalls} unresolved calls of nil across ${lines} lines`);
  }

  // 2. A lift that is a rounding error next to its input was cut short. Real
  //    source can legitimately be smaller than its obfuscated form, but not by
  //    two orders of magnitude: this catches a stub standing in for a script.
  if (sourceBytes > 20000 && bytes * 100 < sourceBytes) {
    problems.push(`output is ${bytes} bytes against a ${sourceBytes} byte input `
      + `(<1%), so the lift stopped early`);
  }

  // 3. Dead branches: `if nil` / `if false` can never take the then-branch, so
  //    the represented control flow is not the real one.
  const deadBranches = (lifted.match(/\bif\s+(?:nil|false)\s+then\b/g) || []).length;

  // 4. Duplicated branch bodies: `if X then A else A end`. The lifter emitted
  //    an identical statement on both sides, i.e. it lost the distinction.
  const dupBranches =
    (lifted.match(/\bif\b[^\n]*\bthen\b\s*\n?\s*([^\n;]+)\s*\n?\s*\belse\b\s*\n?\s*\1\s*(?:\n|$)/g) || []).length;

  // 5. Upvalues promoted to globals. A Luraph chunk writes the VM's upvalues
  //    through the chunk's own environment; the lifter had them in scope when
  //    it produced the preamble (`local v2 = upv2`), so an unqualified
  //    assignment to that name is a scope-loss bug, not a style choice.
  const upvalueGlobals = new Set();
  for (const m of lifted.matchAll(/^[ \t]*([A-Za-z_]\w*)\s*(?:=[^=]|\.\w+\s*=[^=]|\[[^\]]*\]\s*=[^=])/gm)) {
    const name = m[1];
    if (/^(?:up|upv|glb|env)\w*/i.test(name)) upvalueGlobals.add(name);
  }

  if (deadBranches > 0) problems.push(`${deadBranches} dead 'if nil/false' branch(es)`);
  if (dupBranches > 0) problems.push(`${dupBranches} branch(es) with identical then/else bodies`);
  if (upvalueGlobals.size > 0) {
    problems.push(`${upvalueGlobals.size} upvalue(s) assigned as globals `
      + `(${[...upvalueGlobals].slice(0, 6).join(', ')})`);
  }

  // 6. A lift with no structure at all: no function, no call, no string.
  const hasCall = /\w\s*\(/.test(lifted);
  const hasString = /["']/.test(lifted);
  const hasFunction = /\bfunction\b/.test(lifted);
  if (lines > 1 && !hasCall && !hasString && !hasFunction) {
    problems.push('output contains no function, call or string literal');
  }

  return {
    ok: problems.length === 0,
    nilCalls,
    lines,
    stmts,
    bytes,
    sourceBytes,
    deadBranches,
    dupBranches,
    upvalueGlobals: [...upvalueGlobals],
    problems,
  };
}

/** One-line reason suitable for a note or a log line. */
function describeLiftFailure(verdict) {
  return verdict.problems.join('; ');
}

async function run(job) {
  const { args } = job;
  const devirtOn = !args.noDevirt;
  let source = job.source;

  let patched;
  try {
    patched = args.noHooks ? source : vmmap.patchEntries(source, job.sourcePath, harness.chunkKey(source));
  } catch (e) {
    process.stderr.write(`[!] AST parse failed: ${e.message}\n`);
    throw e;
  }

  let spin = true;
  if (spin) patched = vmmap.patchSpin(patched);

  const cachePath = harness.loadP2dCache(job.input);
  const runner = new harness.Runner(job);

  const skip = [];
  const chunks = {};
  const rawChunks = {};
  let body = null;
  let trapped = null;
  let cfg = null;
  let liftFailure = null;

  for (let attempt = 1; attempt <= args.maxRuns; attempt++) {
    cfg = {
      time_budget: args.budget,
      dump_strings: args.strings,
      executor: args.executor,
      skip_protos: skip,
      devirt: devirtOn,
    };
    if (args.inputText) cfg.input_text = args.inputText;
    if (args.preludeFile) cfg.prelude = require('fs').readFileSync(args.preludeFile, 'latin1');
    if (args.noFold) cfg.fold = false;
    if (spin) cfg.spin = SPIN_CHECKS;
    if (args.cfgJson) Object.assign(cfg, args.cfgJson);

    process.stderr.write(`[*] tracing ${job.input} (run ${attempt})...\n`);
    const res = await runner.run(patched, cfg, chunks);
    body = res.body;

    if (!body) {
      runner.finish();
      throw new Error(res.err || 'Trace failed without output');
    }

    body = harness.takeP2d(body);

    const { chunks: found, body: cleanBody } = harness.takeChunks(body);
    body = cleanBody;
    let added = 0;
    for (const [key, src] of found) {
      if (!chunks[key]) {
        rawChunks[key] = src;
        chunks[key] = patchChunk(src, job.outdir, key);
        if (spin) chunks[key] = vmmap.patchSpin(chunks[key]);
        added++;
      }
    }
    if (added > 0) {
      process.stderr.write(`[*] script loadstring'd ${added} new VM chunk(s); instrumenting and re-running\n`);
      continue;
    }

    const trig = new RegExp(harness.mark('TRIGGER ') + '(\\d+)').exec(body);
    if (trapped !== null && trace.stmtCount(body) < trace.stmtCount(trapped[0])) {
      process.stderr.write(`[*] disabling function #${skip[skip.length - 1]} made script stop earlier: keeping run ${attempt - 1}\n`);
      body = trapped[0];
      skip.pop();
      break;
    }
    if (!trig) break;

    trapped = [body, harness.getLastRaw()];
    const pid = parseInt(trig[1], 10);
    if (skip.includes(pid)) {
      process.stderr.write(`[!] anti-tamper trigger ${pid} fired again; giving up on reruns\n`);
      break;
    }
    process.stderr.write(`[*] anti-tamper trap reached through function #${pid}; disabling it and re-running\n`);
    skip.push(pid);
  }

  const runText = harness.traceText(body);
  body = harness.p2dMiss(body, cachePath);
  body = body.replace(new RegExp(harness.mark('TRIGGER ') + '\\d+\\n?', 'g'), '');

  const [protosJson, b1] = trace.takeLine(body, 'PROTOS');
  body = b1;
  const [force, b2] = trace.takeLine(body, 'FORCE');
  body = b2;
  if (force && devirtOn) process.stderr.write(`[*] constants decoded on request: ${force}\n`);

  const [unscrambled, b3] = trace.takeLine(body, 'UNSCRAMBLED');
  body = b3;
  if (unscrambled && devirtOn)
    process.stderr.write(`[*] ${unscrambled} function(s) scrambled by LPH_CRASH(): dumped as created\n`);

  const [b4, strings] = trace.takeStrings(body);
  body = b4;

  // The trace is the executed subset of the program. Say so in the artifact
  // itself, because a reader cannot tell a full decompile from a partial trace
  // once the file is on disk.
  const noteHeader = 'OUTPUT-KIND: trace (not devirtualized) - only code paths executed during tracing are present';
  const antiTamperNote = skip.length
    ? 'this trace skipped anti-tamper-guarded functions, so it is incomplete'
    : null;

  // writeTrace is deferred until the lift outcome is known, so the artifact's
  // own banner can name the real reason instead of a generic one.
  function writeTrace(failureReason) {
    const notes = [noteHeader];
    if (antiTamperNote) notes.push(antiTamperNote);
    if (failureReason) notes.push(`reason: ${failureReason}`);
    // tidy() runs on the body only. Running it over header+body used to work by
    // accident; keeping the two separate means the banner can never be eaten by
    // the formatter (stripPreamble cuts everything above the last known marker).
    const tidied = tidy.tidy(body, { preamble: !args.keepPreamble });
    job.write(job.tracePath, trace.header(job.input, notes) + tidied);
  }

  if (strings) job.write(job.path('.strings.txt'), strings);

  const dpath = job.path('.devirt.luau');
  if (protosJson) {
    const ppath = job.path('.protos.json');
    if (protosJson.startsWith('error:')) {
      process.stderr.write(`[!] proto capture failed: ${protosJson}\n`);
      liftFailure = `proto capture failed: ${protosJson}`;
    } else {
      job.write(ppath, protosJson);
      if (devirtOn) {
        const chunkPaths = Object.entries(rawChunks).map(([k, src]) =>
          job.write(job.path(`.chunk_${k}.luau`), src, 'latin1')
        );

        const cfgData = {
          input: job.input,
          source: job.source,
          source_path: job.sourcePath,
          trace_path: job.tracePath,
          debug: job.debug,
          obfuscator: job.obfuscator,
          luau_exe: runner.luau,
          patched: patched,
          cfg: cfg,
          chunks: chunks,
          run_text: runText,
          ppath: ppath,
          dpath: dpath,
          chunk_paths: chunkPaths,
          args: {
            budget: args.budget,
            timeout: args.timeout,
            devirt_rounds: args.devirtRounds || 200,
            studio: false,
            no_fold: args.noFold || false,
            strings: args.strings || false,
            executor: args.executor || 'Wave',
          },
        };
        // Python stage: several candidates in parallel (PyPy + fixed hash seeds),
        // best result kept -- see src/parallel.js. DEOB_KEEP_CFG=1 keeps the inputs.
        try {
          await require('./parallel').runCandidates(cfgData, job);
        } catch (e) {
          liftFailure = e.message || String(e);
          process.stderr.write(`[!] devirtualization failed: ${liftFailure}\n`);
        }
      }
    }
  } else {
    liftFailure = 'the trace produced no VM prototype data to lift';
  }

  runner.finish();
  trace.statusLine(body);

  if (devirtOn && fs.existsSync(dpath)) {
    const lifted = fs.readFileSync(dpath, 'utf8');
    const verdict = judgeLift(lifted, { sourceBytes: Buffer.byteLength(job.source, 'latin1') });
    if (verdict.ok) {
      process.stderr.write(`[*] devirtualized: ${verdict.stmts} statements, ${verdict.lines} lines, `
        + `${verdict.nilCalls} unresolved calls\n`);
      return { path: dpath, kind: 'devirtualized', stats: verdict };
    }
    process.stderr.write(`[!] the devirtualized output is unusable: ${describeLiftFailure(verdict)}\n`);
    liftFailure = describeLiftFailure(verdict);
    if (!job.debug) { try { fs.unlinkSync(dpath); } catch {} }
  }

  if (devirtOn && !liftFailure) liftFailure = 'the lifter produced no output';
  if (!devirtOn) liftFailure = null;   // devirtualization was switched off on purpose

  if (!liftFailure) {
    process.stderr.write('[*] writing behaviour trace (devirtualization disabled with --no-devirt)\n');
  } else {
    process.stderr.write('[!] devirtualization produced no usable source; writing behaviour trace '
      + '(this is a PARTIAL reconstruction)\n');
  }
  // Always rewrite the trace so it carries the failure reason, even when an
  // earlier branch already wrote an unlabelled copy.
  if (!job.debug) writeTrace(liftFailure);
  return { path: job.tracePath, kind: 'trace', reason: liftFailure, stats: null };
}

async function runGeneric(job) {
  const { args } = job;
  const cachePath = harness.loadP2dCache(job.input);
  const runner = new harness.Runner(job);
  const cfg = {
    time_budget: args.budget,
    executor: args.executor,
    dump_strings: args.strings,
  };
  if (args.inputText) cfg.input_text = args.inputText;
  if (args.noFold) cfg.fold = false;
  if (args.cfgJson) Object.assign(cfg, args.cfgJson);

  process.stderr.write(`[*] tracing ${job.input}...\n`);
  const res = await runner.run(job.source, cfg);
  if (!res.body) {
    runner.finish();
    throw new Error(res.err || 'Trace failed without output');
  }
  runner.finish();
  let body = harness.takeP2d(res.body);
  body = harness.p2dMiss(body, cachePath);
  const { body: cleanBody } = harness.takeChunks(body);
  body = cleanBody;
  const [cleanTrace, strings] = trace.takeStrings(body);
  body = cleanTrace;

  const text = trace.header(job.input, [
    'OUTPUT-KIND: trace (not devirtualized) - only code paths executed during tracing are present',
  ]) + tidy.tidy(body, { preamble: false });
  job.write(job.tracePath, text);
  if (strings) job.write(job.path('.strings.txt'), strings);
  trace.statusLine(body);
  return { path: job.tracePath, kind: 'trace', reason: 'this obfuscator has no devirtualizer; the engine only records behaviour', stats: null };
}

module.exports = { run, runGeneric, judgeLift, describeLiftFailure };
