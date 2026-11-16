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

  // 2. A lift that is a rounding error next to its input is usually a stub, but
  //    the ratio alone cannot decide it: a 286 KB obfuscated file can legitimately
  //    hold a 2-line script, and this rule once rejected exactly that correct
  //    lift. Size collapse therefore only counts as evidence when the output
  //    also fails a structural check -- the real tells are below.
  const sizeCollapsed = sourceBytes > 20000 && bytes * 100 < sourceBytes;

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

  // These three are the signs of a stub assembled from VM bookkeeping: control
  // flow that cannot run, scope that was lost, or a body with no behaviour. A
  // small output on its own is not a defect, so the ratio is only reported when
  // one of them already fired.
  const looksLikeStub = deadBranches > 0 || dupBranches > 0 || upvalueGlobals.size > 0;
  if (sizeCollapsed && looksLikeStub) {
    problems.push(`output is ${bytes} bytes against a ${sourceBytes} byte input (<1%), `
      + 'so the lift stopped early');
  }

  // 6. A lift with no structure at all: no function, no call, no string.
  const hasCall = /\w\s*\(/.test(lifted);
  const hasString = /["']/.test(lifted);
  const hasFunction = /\bfunction\b/.test(lifted);
  if (lines > 1 && !hasCall && !hasString && !hasFunction) {
    problems.push('output contains no function, call or string literal');
  }

  // 7. The output is the VM runtime, not the script. devirt.py emits one of
  //    these stubs for every runtime function it found in the VM object, so a
  //    lift largely made of them means the walker traversed the decoy bootstrap
  //    VM instead of the payload. That output is well-formed Lua with real
  //    calls and strings -- every check above passes it, and it is what a
  //    284 KB sample produced as a "successful" devirtualization.
  //
  //    Thresholds calibrated on the real lift: a decoy-VM run produced only 2
  //    stubs among 50 function keywords, so counting stubs alone cannot
  //    distinguish it. What is unmistakable is a body where the stubs are the
  //    content -- each is a three-line `local function ... error(...) end`, so
  //    a body whose function definitions are mostly these is the runtime. A
  //    stub that merely appears inside ordinary code is spared.
  const runtimeStubs = (lifted.match(
    /error\(\s*"Luraph runtime function, not devirtualized"\s*\)/g) || []).length;
  const declaredFunctions = (lifted.match(/\blocal\s+function\b|\bfunction\b/g) || []).length;
  if (runtimeStubs >= 3 && runtimeStubs * 2 >= declaredFunctions) {
    problems.push(`${runtimeStubs} of ${declaredFunctions} function(s) are VM runtime stubs `
      + '-- the bootstrap VM was lifted instead of the script');
  }

  // 8. Hidden VM state printed by name. codegen renders a `Pseudo` (numeric or
  //    generic for-loop state) as `%s_%d` -- the VM's own variable name plus its
  //    stack depth. Those are never declared, because the pseudo is supposed to
  //    be consumed by the for-loop the lifter recognises; when that recognition
  //    fails, the statement that binds the variable is gone and every use is
  //    left dangling as a global.
  //
  //    A real v15.1 lift carried `c_1`, `p_1`, `N_1` this way -- syntax-valid
  //    Luau (Luau parses an unknown name as a global), so every check above
  //    passed it and the output read as a correct lift while three loop bounds
  //    were undefined at run time.
  //
  //    The pattern is narrow on purpose: the name is the VM's own variable name
  //    -- a short identifier with no digits -- and the suffix is a small stack
  //    depth. The letter case is not fixed, because the VM's locals are not
  //    (`N_1` was measured alongside `c_1` and `p_1` in the same lift). Ordinary
  //    globals (`Players`, `game`) and the naming pass's wordlist (`str2`, `fn3`)
  //    carry no underscore and can never match; a register name (`r2_1`) has
  //    digits before the underscore, so it is a different shape and also passes.
  //    A `local` statement can declare several names at once
  //    (`local a, b, c = 0, 0, 0`), so every target before the `=` has to be
  //    collected -- taking only the first would report the rest as leaked.
  const declared = new Set();
  for (const m of lifted.matchAll(/\blocal\s+function\s+([A-Za-z_]\w*)/g)) declared.add(m[1]);
  for (const m of lifted.matchAll(/\blocal\s+([^=\n]*)/g)) {
    for (const part of m[1].split(',')) {
      const nm = part.trim().match(/^([A-Za-z_]\w*)/);
      if (nm) declared.add(nm[1]);
    }
  }
  for (const m of lifted.matchAll(/\bfunction\s+([A-Za-z_]\w*)\s*\(/g)) declared.add(m[1]);
  for (const m of lifted.matchAll(/\bfor\s+([A-Za-z_][\w,\s]*?)\s+(?:=|in)\b/g)) {
    for (const part of m[1].split(',')) declared.add(part.trim());
  }
  const pseudoGlobals = new Set();
  for (const m of lifted.matchAll(/\b([A-Za-z][A-Za-z_]*_\d{1,2})\b/g)) {
    const name = m[1];
    if (declared.has(name)) continue;
    if (!/^(?:[A-Za-z]|JIT\d+)_\d{1,2}$/.test(name)) continue;
    pseudoGlobals.add(name);
  }
  if (pseudoGlobals.size > 0) {
    problems.push(`${pseudoGlobals.size} hidden VM loop variable(s) printed as undeclared `
      + `globals (${[...pseudoGlobals].slice(0, 6).join(', ')})`);
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
    runtimeStubs,
    pseudoGlobals: [...pseudoGlobals],
    upvalueGlobals: [...upvalueGlobals],
    sizeCollapsed,
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
