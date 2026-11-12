"""A fake ``codex`` CLI (OpenAI Codex CLI) for the ⌨ command-line mode tests (Codex is not installed in CI).

It mimics what Akọwe uses of the real one (checked against the Codex source: codex-rs/exec/src/cli.rs,
codex-rs/utils/cli/src/shared_options.rs, codex-rs/cli/src/login.rs):

* ``codex --version`` -> "codex-cli 0.167.2";
* ``codex login status`` -> exit 0 "Logged in using ChatGPT" (stderr), or exit 1 "Not logged in";
* ``codex exec [--skip-git-repo-check] [--ephemeral] [--sandbox read-only] [--color never] [-C DIR] [-o FILE]
  [-m MODEL] [-i FILE]... -`` with the instructions on stdin -> progress on stderr, the final message on stdout and
  in the ``-o`` file.

The answer: an Akọwe module request (``JSON_SCHEMA:`` in the prompt) is answered by the Make-a-book fake AI
(tests/autobook_fake.py: BookFakeAI, a fresh one per process), so a whole ⚡ run works through this fake.

Modes (env FAKE_CODEX_MODE): ok, logged_out (exec and login status say "Not logged in"), limit (a usage-limit
message with "Try again at 3:45 PM."), slow (sleeps FAKE_CODEX_SLOW s, default 60; writes its pid to FAKE_CODEX_PIDS),
crash, malformed (prose, no JSON), old (refuses --ephemeral: "unexpected argument"), no_images (refuses -i).
FAKE_CODEX_LOG: a folder where each call writes {argv, stdin_chars, cwd, cwd_files, images, mode, start, end}.
FAKE_CODEX_PICTURE_VERDICT: the "verdict" of a picture-judge answer (default "keep").
"""
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.dirname(HERE)
AKOWE = os.path.dirname(TESTS)


def env(k, d=""):
    return os.environ.get(k, d)


def fake_answer(prompt):
    """The answer to an Akọwe module prompt: the Make-a-book fake AI's, by the schema's shape."""
    sys.path[:0] = [AKOWE, TESTS]
    from autobook_fake import BookFakeAI  # noqa: PLC0415
    m = re.search(r"JSON_SCHEMA:\n(.*?)\nEND_JSON_SCHEMA", prompt, re.S)
    schema = json.loads(m.group(1)) if m else {}
    um = re.search(r"(Project context package \(JSON\):\n.*?)\n\nJSON_SCHEMA:", prompt, re.S)
    if um is None:
        return {}
    sm = prompt.split(um.group(1))[0]
    data, _usage = BookFakeAI().submit({"slot_id": env("FAKE_CODEX_SLOT", "AI-2")}, sm, um.group(1), schema)
    return data


def main():
    argv = sys.argv[1:]
    mode = env("FAKE_CODEX_MODE", "ok")
    if argv[:1] == ["--version"]:
        print("codex-cli 0.167.2")
        return 0
    if argv[:2] == ["login", "status"]:
        if mode == "logged_out":
            print("Not logged in", file=sys.stderr)
            return 1
        print("Logged in using ChatGPT", file=sys.stderr)
        return 0
    if argv[:1] != ["exec"]:
        print("interactive mode is not faked", file=sys.stderr)
        return 2
    t0 = time.time()
    if mode == "old" and "--ephemeral" in argv:
        print("error: unexpected argument '--ephemeral' found", file=sys.stderr)
        return 2
    if mode == "no_images" and "-i" in argv:
        print("error: unexpected argument '-i' found", file=sys.stderr)
        return 2
    if argv[-1] != "-":
        print("the fake expects the prompt on stdin ('-')", file=sys.stderr)
        return 2
    out_file = argv[argv.index("-o") + 1] if "-o" in argv else None
    images = [argv[i + 1] for i, a in enumerate(argv) if a == "-i"]
    cwd = argv[argv.index("-C") + 1] if "-C" in argv else os.getcwd()
    prompt = sys.stdin.read()
    logdir = env("FAKE_CODEX_LOG")

    def log(**kw):
        if logdir:
            with open(os.path.join(logdir, f"{os.getpid()}-{time.time_ns()}.json"), "w", encoding="utf-8") as f:
                json.dump(dict(argv=argv, stdin_chars=len(prompt), cwd=cwd, cwd_files=sorted(os.listdir(cwd)),
                               images=images, images_exist=[os.path.isfile(p) for p in images], mode=mode, start=t0,
                               end=time.time(), env_keys=sorted(k for k in os.environ if k.endswith("API_KEY")),
                               **kw), f)

    print("[codex] working…", file=sys.stderr)
    if mode == "slow":
        pidfile = env("FAKE_CODEX_PIDS")
        if pidfile:
            with open(pidfile, "w") as f:
                f.write(str(os.getpid()))
        time.sleep(float(env("FAKE_CODEX_SLOW", "60")))
    if mode == "logged_out":
        print("ERROR: Not logged in. Run `codex login` to sign in.", file=sys.stderr)
        log(outcome="logged_out")
        return 1
    if mode == "limit":
        print("ERROR: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit "
              "https://chatgpt.com/settings/usage to purchase more credits or try again at 3:45 PM.", file=sys.stderr)
        log(outcome="limit")
        return 1
    if mode == "crash":
        print("thread 'main' panicked", file=sys.stderr)
        log(outcome="crash")
        return 101
    if mode == "malformed":
        text = "Sure! Here is my answer, but not as JSON."
    elif images:
        text = json.dumps({"verdict": env("FAKE_CODEX_PICTURE_VERDICT", "keep"),
                           "saw": sum(os.path.isfile(p) for p in images)})
    elif "JSON_SCHEMA:" in prompt and "Project context package (JSON):" in prompt:
        text = "```json\n" + json.dumps(fake_answer(prompt)) + "\n```"
    else:
        text = json.dumps({"ok": True})
    if out_file:
        with open(out_file, "w", encoding="utf-8") as f:
            f.write(text)
    print(text)
    log(outcome="ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
