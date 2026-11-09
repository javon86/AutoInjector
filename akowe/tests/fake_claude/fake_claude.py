"""A fake ``claude`` CLI for the tests (Claude Code is not installed in CI or the sandbox).

It mimics what Akọwe uses of the real one (code.claude.com/docs/en/headless, /cli-reference):

* ``claude --version`` -> "2.1.300 (Claude Code)";
* ``claude -p "<instruction>" --output-format json …`` with the prompt on stdin -> ONE JSON result object
  {"type": "result", "subtype": "success", "is_error": false, "result": "<text>", "total_cost_usd": …, "usage": …}.

Modes (env FAKE_CLAUDE_MODE, or FAKE_CLAUDE_MODE_<JOB> for one job kind): ok, malformed, logged_out, limit, slow,
slow_tree (also starts a child process), crash, unknown_flag (refuses --permission-mode), flaky (crashes on the first
call only; state file FAKE_CLAUDE_STATE). FAKE_CLAUDE_DELAY: seconds to wait before answering. FAKE_CLAUDE_LOG: a folder
where each call writes {job, start, end, pid, argv, stdin_chars, argv_chars} (for the overlap and privacy tests).
FAKE_CLAUDE_FACTS=wrong: the fact check finds one wrong claim with a fix. FAKE_CLAUDE_STANDIN (stand_in job):
accept | keep | unsure | low (a low confidence). FAKE_CLAUDE_PROBLEM=1: continuity finds one.
Step 2 jobs: prepare (two scene cards and an empty needs list), variety, the specialists (dialogue / pacing / sensory /
subtext: one minor problem with FAKE_CLAUDE_SPECIALIST=1), style and specifics (line rewrites), bible_fill (every
asked field) and launch_kit (every asked field in its shape).
"""
import json
import os
import re
import subprocess
import sys
import time


def env(k, d=""):
    return os.environ.get(k, d)


def long_texts(obj, out):
    if isinstance(obj, str):
        if len(obj) >= 120:
            out.append(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            long_texts(v, out)
    elif isinstance(obj, list):
        for v in obj:
            long_texts(v, out)
    return out


def first_sentence(text):
    m = re.search(r"[A-Z][^.!?\n]{10,200}[.!?]", text or "")
    return m.group(0) if m else ""


def answer(job, ctx):
    if job == "login_check":
        return {"ok": True}
    if job == "stand_in":  # 🧑‍⚖️ FAKE_CLAUDE_STANDIN: accept (default) | keep | unsure | low (one vote)
        how = env("FAKE_CLAUDE_STANDIN", "accept")
        choice = "unsure"
        for o in ctx.get("options") or []:  # the letter of the option this mode means (the order is random)
            does = o.get("does") or ""
            accept = "corrected version" in does or "as it is" in does
            if (how in ("accept", "low") and accept) or (how == "keep" and not accept):
                choice = o.get("letter")
        return {"choice": choice, "confident": 0.4 if how == "low" else 0.92,
                "why": f"Claude Code read the finding and the canon ({how})."}
    if job == "research":
        notes = []
        for c in ctx.get("chapters") or []:
            n = c["number"]
            notes += [{"chapter": n, "topic": "Lighthouse lenses", "note": f"Fresnel lenses were used from 1823 (ch {n}).",
                       "label": "established", "source_url": "https://example.org/fresnel"},
                      {"chapter": n, "topic": "The drowned keeper", "note": "A local legend, not a recorded event.",
                       "label": "legend", "source_url": "https://example.org/legend"},
                      {"chapter": n, "topic": "Unsourced", "note": "A claim with no source must be dropped.",
                       "label": "established"}]
        return {"notes": notes}
    if job == "facts":
        text = ctx.get("chapter_text") or ""
        s = first_sentence(text)
        words = s.split()
        claims = []
        if words:
            q = " ".join(words[:4])
            if env("FAKE_CLAUDE_FACTS") == "wrong" and text.count(q) == 1:
                claims.append({"quote": q, "claim": "a wrong date", "verdict": "wrong", "label": "established",
                               "source_url": "https://example.org/date", "why": "it was later", "severity": "major",
                               "original": q, "replacement": q + " (later)"})
            else:
                claims.append({"quote": q, "claim": "a period detail", "verdict": "correct", "label": "established",
                               "source_url": "https://example.org/ok"})
        return {"claims": claims, "summary": "checked"}
    if job in ("continuity", "voice"):
        probs = []
        if env("FAKE_CLAUDE_PROBLEM") == "1" and job == "continuity":
            texts = long_texts(ctx, [])
            s = first_sentence(texts[0]) if texts else ""
            if s:
                probs.append({"chapter": int(env("FAKE_CLAUDE_PROBLEM_CHAPTER", "1")), "quote": s,
                              "problem": "The keeper's injury is forgotten here", "severity": "major"})
        return {"problems": probs, "summary": f"{job} checked"}
    if job == "ai_tells":
        text = ctx.get("chapter_text") or ""
        lines = []
        for s in [x for x in re.findall(r"[A-Z][^.!?\n]{10,200}[.!?]", text) if text.count(x) == 1][:25]:
            lines.append({"quote": s, "problem": "stock rhythm", "rewrite": s[:-1] + ", and that was all."})
        return {"lines": lines}
    # ---- 🤖 Step 2 jobs (claude_code_speed.py)
    if job == "prepare":
        names = [c.get("name") for c in ctx.get("characters") or [] if c.get("name")][:2] or ["Mara"]
        n = (ctx.get("chapter") or {}).get("number") or 1
        cards = [{"place": f"The lamp room ({k})", "time": "dusk", "characters": names,
                  "goals": [{"character": nm, "goal": "keep the light burning", "hidden_agenda": "hide the logbook"}
                            for nm in names],
                  "obstacle": "the storm cuts the supply boat", "obstacle_source": "weather",
                  "change": f"scene {k} of chapter {n} turns", "unsaid": "who broke the lens", "beat": "the objective"}
                 for k in (1, 2)]
        return {"scenes": cards, "needs": {"things": [], "earlier": [], "notes": []}}
    if job == "variety":
        used = ctx.get("used_so_far") or []
        first = used[0]["chapter"] if used else 1
        return {"opening": {"repeats": True, "chapters": [first, 99],
                            "advice": "Open on the cracked lens in her hands, not on the weather."},
                "closing": {"repeats": False, "chapters": [], "advice": ""}}
    if job in ("dialogue", "pacing", "sensory", "subtext"):
        probs = []
        if env("FAKE_CLAUDE_SPECIALIST") == "1":
            s = first_sentence(ctx.get("chapter_text") or "")
            if s:
                probs.append({"chapter": ctx.get("chapter") or 1, "quote": s, "problem": f"{job} problem here",
                              "severity": "minor"})
        return {"problems": probs, "summary": f"{job} checked"}
    if job in ("style", "specifics"):
        text = ctx.get("chapter_text") or ""
        lines = []
        for i, s in enumerate([x for x in re.findall(r"[A-Z][^.!?\n]{10,200}[.!?]", text) if text.count(x) == 1][:6]):
            ln = {"quote": s, "problem": f"{job} line", "rewrite": s[:-1] + ", brass-cold and close."}
            if job == "specifics":
                ln["type"] = ("generic_detail", "tidy_dialogue")[i % 2]
            lines.append(ln)
        return {"lines": lines, "summary": job}
    if job == "bible_fill":
        out = {}
        for subj in ctx.get("subjects") or []:
            for k, label in (subj.get("fields") or {}).items():
                out[k] = "ally" if "Relationship type with " in str(label) else "4 — weathered brass and salt-stained wool"
        return out
    if job == "launch_kit":
        out = {}
        for f in ctx.get("fields") or []:
            if f in ("blurb_short", "blurb_long", "author_bio"):
                out[f] = " ".join(["The keeper keeps the light while the storm keeps coming."] * (8 if f != "blurb_long" else 18))
            elif f == "hook":
                out[f] = "One keeper, one storm, and a light that must not go out."
            elif f == "keywords":
                out[f] = ["lighthouse mystery", "storm novel", "keeper secrets", "coastal suspense",
                          "victorian lighthouse", "family secret book", "sea storm story"]
            elif f == "categories":
                out[f] = list((ctx.get("category_choices") or [])[:3])
            elif f == "comps":
                out[f] = [{"title": f"Book {i}", "author": f"Writer {i}", "why": "a lighthouse story"} for i in (1, 2, 3)]
            elif f == "aplus":
                out[f] = [{"headline": f"Module {i}", "text": "The light, the storm and the keeper.", "image": ""}
                          for i in (1, 2, 3)]
        return out
    return {}


def main():
    argv = sys.argv[1:]
    if "--version" in argv or "-v" in argv:
        print("2.1.300 (Claude Code)")
        return 0
    if "-p" not in argv and "--print" not in argv:
        print("interactive mode is not faked", file=sys.stderr)
        return 2
    t0 = time.time()
    stdin = sys.stdin.read()
    m = re.search(r"^JOB: (\w+)", stdin, re.M)
    job = m.group(1) if m else ("login_check" if "OK" in stdin else "unknown")
    mode = env(f"FAKE_CLAUDE_MODE_{job.upper()}") or env("FAKE_CLAUDE_MODE", "ok")
    delay = float(env("FAKE_CLAUDE_DELAY", "0") or 0)
    if job == "login_check":
        delay = 0
        if mode in ("slow", "slow_tree", "flaky"):
            mode = "ok"
    logdir = env("FAKE_CLAUDE_LOG")

    def log(**kw):
        if logdir:
            with open(os.path.join(logdir, f"{os.getpid()}-{time.time_ns()}.json"), "w", encoding="utf-8") as f:
                json.dump(dict(job=job, start=t0, end=time.time(), pid=os.getpid(), argv=argv,
                               rel=("Relationship type with " in stdin) if job == "bible_fill" else None,
                               stdin_chars=len(stdin), argv_chars=sum(len(a) for a in argv), cwd=os.getcwd(),
                               cwd_files=os.listdir(os.getcwd()), mode=mode, **kw), f)

    if mode == "unknown_flag" and "--permission-mode" in argv:
        print("error: unknown option '--permission-mode'", file=sys.stderr)
        log(outcome="unknown_flag")
        return 1
    if mode == "flaky":
        st = env("FAKE_CLAUDE_STATE")
        if st and not os.path.exists(st):
            open(st, "w").close()
            print("Segmentation fault", file=sys.stderr)
            log(outcome="crash")
            return 139
    if mode in ("slow", "slow_tree"):
        pidfile = env("FAKE_CLAUDE_PIDS")
        child = None
        if mode == "slow_tree":
            child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        if pidfile:
            with open(pidfile, "w") as f:
                f.write(f"{os.getpid()} {child.pid if child else ''}")
        time.sleep(float(env("FAKE_CLAUDE_SLOW", "60")))
    if delay:
        time.sleep(delay)
    if mode == "crash":
        print("boom", file=sys.stderr)
        log(outcome="crash")
        return 3
    if mode == "malformed":
        print("this is not json {")
        log(outcome="malformed")
        return 0
    if mode == "logged_out":
        print(json.dumps({"type": "result", "subtype": "success", "is_error": True,
                          "result": "Not logged in · Please run /login", "total_cost_usd": 0}))
        log(outcome="logged_out")
        return 1
    if mode == "limit":
        print(json.dumps({"type": "result", "subtype": "success", "is_error": True,
                          "result": "You've hit your session limit · resets 3:45pm", "total_cost_usd": 0}))
        log(outcome="limit")
        return 1
    ctx = {}
    mm = re.search(r"CONTEXT \(JSON\):\n(.*)\Z", stdin, re.S)
    if mm:
        try:
            ctx = json.loads(mm.group(1))
        except ValueError:
            ctx = {}
    text = json.dumps(answer(job, ctx))
    if env("FAKE_CLAUDE_FENCE") == "1":
        text = "Here you go:\n```json\n" + text + "\n```"
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": text,
                      "total_cost_usd": 0.01, "usage": {"input_tokens": len(stdin) // 4, "output_tokens": 50},
                      "duration_ms": int((time.time() - t0) * 1000), "num_turns": 1, "session_id": "fake"}))
    log(outcome="ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
