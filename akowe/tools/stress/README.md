# ⚡ Make-a-book stress harness

Findings only: the harness never changes product code (`akowe/akowe/` stays untouched). It injects faults from the
outside, runs a whole book with the Practice AI in a throw-away data folder under `/dev/shm`, and classifies what
happened:

| Mark | Meaning |
|---|---|
| ✅ HANDLED | the book still finished, nothing lost |
| 🟡 SAFE STOP | paused with a clear problem (code + plain words + fix, no traceback); after the fault was removed, Resume finished the book |
| ❌ PROBLEM | crash, traceback in the problem, hang, stuck “running”, work lost, Resume cannot finish, wrong message, book text or keys in logs |
| ⚠️ WORKED BUT RISKY | e.g. an optional part stops the book, a message blames the wrong thing |

## Run it (from the `akowe` folder)

```
python -m tools.stress.run --section A                    # every part and stress of section A, writes the report
python -m tools.stress.run --section A --parts 2          # one part (subsections: --parts 10.2,10.3)
python -m tools.stress.run --section A --stress a,k       # some stresses
python -m tools.stress.run --section A --no-write         # print only
python -m tools.stress.run --section A --list             # the scenario IDs
python -m tools.stress.run --section A --render           # rewrite the .md from the JSON (after adding findings)
```

Reports: `docs/stress/<L>-<slug>.md` and `docs/stress/<L>-results.json` (merged by result ID, so a partial run only
replaces its own rows) and the index `docs/stress/README.md` (rewritten on every write; a section shows as done once
its JSON exists). Result IDs: `<Section>-<part>[.<sub>]-<stress>`, e.g. `C-10.2-k`.

A section takes a few minutes (a whole fake book takes ~2 s). Keep runs modest: one section at a time.

## Add a section (no edit of core.py needed)

Create `tools/stress/section_<letter>.py`:

```python
from .core import LIKELY, UNLIKELY, Harness, Outcome, Rule, Section, Target, busy, replace, text, timeout

SEC = Section("B", "Characters and world", "characters-and-world")
SEC.part("7", "world (story rules & world texture)", "What is law in this world …", step="world")
SEC.part("10.2", "promise ledger", "…", step="outline")          # a subsection: part id "10.2"

# a–i in one line: the step, the answer kinds of its AI calls (practice_ai `_answer` kinds; None = every call
# while the step runs; () = the part makes no AI call) and how to break its own code (default: the step raises)
SEC.std("7", Target(step="world", kinds=("rules", "texture")))

@SEC.stress("7", "j", "the most likely real-life problem: …")            # j and k, l, m… are yours
def b7_j(h: Harness) -> Outcome:
    h.make_app()                                       # wire="bridge", slots=3 for raw reply text
    h.chaos.add(Rule(replace(lambda c: dict(c.out, rules=[])), kinds="rules", step="world"))
    return h.standard(label="No rules at all: ", check=lambda h, run: ([], []))

@SEC.stress("7", "k", "…", likely=UNLIKELY)                            # out of the box: say how likely
def b7_k(h): ...

SEC.finding("B-7-k", where="akowe/akowe/x.py f() line ~N", cause="…", fix="…",
            severity="would lose work", likely=UNLIKELY, what="one line")   # analysed ❌ / ⚠️ details
```

Then `python -m tools.stress.run --section B`. Add your quick ✅ / 🟡 cases to `tests/test_stress_<letter>_smoke.py`
(see `tests/test_stress_a_smoke.py`), never the ❌ ones.

### The toolbox (`core.py`)

* **Faults** — `h.chaos.add(Rule(action, kinds=…, step=…, calls={n}, slots="AI-1", prob=0.5, times=3, skip=1,
  when=fn))`. Actions: `timeout()`, `busy()`, `usage_limit()`, `declined()`, `fail(code, **attrs)`, `replace(value |
  fn(call))` (a wrong but well-formed answer; `call.out` is the good answer), `text(str | fn)` (raw reply text — needs
  `h.make_app(wire="bridge", slots=3)`: an in-process AutoInjector bridge, so the REAL adapter parses it), `crash()`
  (the program stops), `hang(event)`, `callback(fn)` (e.g. press Pause or edit a record during the call).
  `h.chaos.trace` lists every call (n, kind, step, slot, fault).
* **Own code** — `h.patch(obj, "name", fn)` (undone by `h.fix()`), `h.at_step("world", before=fn, after=fn)` (around
  `AutoBookService._s_<step>`).
* **Flows** — `h.standard(...)` start → wait (hang = no finish within the time limit) → done? / stopped → `h.fix()`
  (every fault removed) → ▶ Resume → finished? ; `h.crash_restart(arm)` the program stops inside the part, a new App
  opens the same data folder, the run must read “interrupted”, Resume must finish the book once; `h.pause()`,
  `h.cancel()`, `h.resume()`, `h.restart()`, `h.wait()`, `h.settle()`.
* **Checks** — `h.book_check(run)` (done, title + idea, every step done, files exported, chapters done),
  `h.problem_check(problem)` (code, words, fix, no traceback), `h.scan_logs()` (tracebacks, ERRORs, book text and
  keys in any `akowe` log line; add your own words to `h.markers`), `h.new_projects()` (duplicate books).
  `check=fn(h, run) -> (issues, risks)` adds scenario-specific ❌ / ⚠️ reasons.
* **Generic a–i** — `std_a` … `std_i` (`SEC.std(part, Target(...))`); a custom `@SEC.stress(part, "a")` replaces one.

The harness sets the same safety switches as `tests/conftest.py` (no real books folder, no auto-save, no picture
bridge, no Claude Code CLI) and makes the providers' own 1–4 s retry sleeps instant; retry policies are milliseconds.
