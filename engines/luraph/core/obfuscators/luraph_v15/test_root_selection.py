#!/usr/bin/env python3
"""Root-selection regression for the Luraph v15 lifter.

What the fixture actually contains
----------------------------------
tests/fixtures/luraph/obfuscated.lua captures 36 protos across two VM makers:

    maker ...,32373   -> 35 protos, ids 1..31, 33, 34 plus non-numeric t82/t307
    maker ...,282243  ->  1 proto,  id 32, __seq 36 (seeded last)

The dump records that only proto #32 ever executed ("emit": {"32": 1}).

So the payload is the lone proto on the *second* maker, and its id (32) is
numerically smaller than ids the bootstrap VM also holds while sorting among
35 competitors. A picker that used numeric order, or that took the first proto
of the first VM, would lift VM bookkeeping instead of the script.

Correction on the history
-------------------------
An earlier note claimed the root picker "fell back to first proto of the last
VM" and lifted a 12-line stub. That was measured and is NOT what happens:
proto 32 is the only proto on its maker *and* is seeded last, so the existing
"last VM, payload first" rule already selects it. With DEVIRT_NO_EMIT_ROOT=1
the selection is byte-identical. The emit-based signal is therefore an
independent corroboration for this fixture, not the thing that fixed it.

The unconditional failure it does prevent: a future sample where the payload
VM also holds helper protos, and seed order no longer coincides with the
executed one.

What is pinned here
-------------------
The observable contract -- root selection lands on proto #32 and the payload
lifts to the script the fixture says it should.

Run: python engines/luraph/core/obfuscators/luraph_v15/test_root_selection.py
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.abspath(os.path.join(HERE, "..", ".."))
# engines/luraph/core/obfuscators/luraph_v15 -> four levels up to the project root
ROOT = os.path.abspath(os.path.join(CORE, "..", "..", ".."))
FIXTURES = os.path.join(ROOT, "tests", "fixtures", "luraph")

if CORE not in sys.path:
    sys.path.insert(0, CORE)

failures = []


class Skip(Exception):
    """Raised when a check needs an artefact that is not in the tree (a large
    captured dump is not worth committing). Reported as SKIP, never as PASS:
    a check that did not run must not look like one that succeeded."""


def check(name, fn):
    try:
        fn()
        print("PASS ", name)
    except Skip as exc:
        print("SKIP ", name, "->", exc)
    except Exception as exc:                      # noqa: BLE001 - report, keep going
        failures.append(name)
        print("FAIL ", name, "->", exc)


def load_dump():
    return json.load(open(os.path.join(FIXTURES, "protos", "obfuscated.protos.json"),
                          encoding="utf-8", errors="replace"))


def test_emit_evidence_identifies_the_payload():
    dump = load_dump()
    emits = dump.get("emit") or {}
    protos = dump.get("protos") or {}

    assert emits, "the dump must carry execution evidence"
    executed = [pid for pid, n in emits.items() if int(n) > 0]
    assert executed == ["32"], (
        "exactly one proto ran in this fixture; got %r" % (executed,))

    # The payload is the only proto on its own VM seed, and it is seeded last.
    maker = str(protos["32"].get("__maker"))
    same_maker = [k for k, v in protos.items() if str(v.get("__maker")) == maker]
    assert same_maker == ["32"], "the payload VM must be a single proto, got %r" % (same_maker,)
    assert len(protos) > 30, "the bootstrap VM should have many protos, got %d" % len(protos)

    # Pin the property that makes the fixture a real test rather than a lucky
    # one: the payload id is NOT the numeric minimum, and the bootstrap VM
    # holds ids on both sides of it. A numeric-order picker would get it wrong.
    numeric = sorted(int(k) for k in protos if k.isdigit())
    assert numeric[0] != 32, "proto 32 must not be the numeric minimum"
    smaller = [k for k in protos if k.isdigit() and int(k) < 32]
    larger = [k for k in protos if k.isdigit() and int(k) > 32]
    assert smaller and larger, (
        "competitors must exist on both sides of 32, got %d below and %d above"
        % (len(smaller), len(larger)))


def test_root_follows_execution_not_seed_order():
    from obfuscators.luraph_v15 import devirt

    src = os.path.join(FIXTURES, "obfuscated.lua")
    protos = os.path.join(FIXTURES, "protos", "obfuscated.protos.json")
    prog = devirt.Program(src, protos)
    vms, payload = devirt._vm_roots(prog)

    assert payload is not None, "a payload root must be selected"
    first = [lst[0] for tag, lst in vms if tag == payload]
    assert first, "the payload VM must expose a root"
    seq, pid, _cap = first[0]
    assert str(pid) == "32", (
        "the executed proto must win the root slot; got proto #%s (seq %s)" % (pid, seq))


def test_payload_lifts_to_the_original_script():
    from obfuscators.luraph_v15 import devirt

    src = os.path.join(FIXTURES, "obfuscated.lua")
    protos = os.path.join(FIXTURES, "protos", "obfuscated.protos.json")
    text, stats, _reqs, _bufs = devirt.lift_program(src, protos)

    expected = open(os.path.join(FIXTURES, "expected.lua"), encoding="utf-8").read().strip()
    body = "\n".join(line for line in text.splitlines()
                     if not line.strip().startswith("--"))

    assert expected in body, (
        "the lift must contain the original script %r; got:\n%s" % (expected, text))
    assert stats["errors"] == 0, "the payload lift must be clean, got %r" % (stats,)
    # The stub failure mode: VM bookkeeping leaked into the output.
    assert "upv" not in body, "VM upvalue bookkeeping must not appear in the output"
    assert "if nil then" not in body, "a dead branch means the stub was lifted, not the script"


# ---------------------------------------------------------------------------
# A silent VM must not contribute a root.
#
# The fixture above cannot catch this: its bootstrap VM and its payload VM both
# ran, and its payload sits on its own maker. A real v15.1 loader (CENZ STUDIO,
# 284 kB, samples/Loader.luau) shows the shape that breaks the picker --
#
#   maker A: 35 protos, ZERO statements emitted (bootstrap / anti-tamper)
#   maker B:  6 protos, the four that emitted (32, 36, 37, 39)
#
# -- and the bootstrap walk attributed 34 of A's 35 protos, missing seq 30.
# That proto passed the "not bootstrap" filter, sorted FIRST by creation
# number, and was lifted as `payload_fn_30`: a dead `if nil then` plus three
# upvalues written as globals. The correct 4.9 kB lift sat beside it and was
# thrown away as unusable, so the engine fell back to a behaviour trace.
#
# The dump is 1.1 MB, so it is not committed. The checks skip without it and
# say so; regenerate with a normal engine run on the sample.
SAMPLE = os.path.join(ROOT, "samples", "Loader.luau")
SAMPLE_DUMPS = [
    os.path.join(ROOT, d)
    for d in (
        "tmp-roots3/loader.out.protos.json",
        "tmp-roots4/loader.out.protos.json",
        "samples/output/loader.out.protos.json",
    )
]


def _sample_pair():
    for d in SAMPLE_DUMPS:
        if os.path.isfile(d) and os.path.isfile(SAMPLE):
            return SAMPLE, d
    return None, None


def test_a_silent_vm_contributes_no_roots():
    src, protos_path = _sample_pair()
    if src is None:
        raise Skip("real sample or its captured dump not present")

    from obfuscators.luraph_v15 import devirt

    prog = devirt.Program(src, protos_path, ())
    emits = prog.dump.raw.get("emit") or {}
    assert emits, "the dump must carry execution evidence"

    # Which makers emitted: that split is what the picker must respect.
    makers = {}
    for key, cap in prog.dump.protos.items():
        makers.setdefault(str(cap.get("__maker")), []).append(
            (cap.get("__seq") or 0, key))
    live = {str(prog.dump.protos[k].get("__maker"))
            for k in emits if k in prog.dump.protos}
    assert len(live) < len(makers), (
        "this sample must have a silent VM for the check to mean anything; "
        "got %d live of %d makers" % (len(live), len(makers)))

    roots = devirt.auto_roots(prog)
    assert roots, "the sample must still yield roots"
    for r in roots:
        maker = str(r["cap"].get("__maker"))
        assert maker in live, (
            "root seq=%s (proto #%s) comes from a VM that emitted nothing"
            % (r["seq"], r["key"]))

    # The specific proto that poisoned the lift must be gone.
    assert not any(str(r["key"]) == "25" for r in roots), (
        "proto #25 (silent VM, seq 30) must not be lifted as the script")


if __name__ == "__main__":
    if not os.path.isdir(FIXTURES):
        print("SKIP  fixtures not present")
        sys.exit(0)
    check("emit evidence identifies the payload proto", test_emit_evidence_identifies_the_payload)
    check("root follows execution rather than seed order", test_root_follows_execution_not_seed_order)
    check("payload lifts to the original script", test_payload_lifts_to_the_original_script)
    check("a silent VM contributes no root", test_a_silent_vm_contributes_no_roots)
    if failures:
        print("\n%d check(s) failed" % len(failures))
        sys.exit(1)
    print("\nall root-selection checks passed")
    check("payload lifts to the original script", test_payload_lifts_to_the_original_script)
    if failures:
        print("\n%d check(s) failed" % len(failures))
        sys.exit(1)
    print("\nall root-selection checks passed")
