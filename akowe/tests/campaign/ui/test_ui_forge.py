"""🗂 B5 Character Forge in the browser: the empty list offers the Moki Vey example; the dossier page shows the hero
portrait, gold name, ten-view plate and lettered section cards; the letter filter; ✔ Approve / ✎ Edit of a proposal;
✔ Approve all → READY; ⬇ Dossier PDF downloads; the "🗂 Character Forge" link on the character's card; no browser
problems, no horizontal overflow on a phone. Screenshots go to $BF_UI_SHOTS (see ui_helpers.shot)."""
from __future__ import annotations

import threading
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from .ui_helpers import assert_clean, bad_text, goto, overflow, settle, shot, unnamed_controls, watch

from test_failover_review import SlotFake, make_app
from test_server import TOKEN


@pytest.fixture
def fg(tmp_path):
    from akowe.server import make_handler
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    pid = app.engine.bootstrap_project("author", "Forge UI book")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    yield SimpleNamespace(app=app, pid=pid, url=f"http://127.0.0.1:{port}/#token={TOKEN}")
    httpd.shutdown()
    httpd.server_close()


def open_page(make_context, fg, **kw):
    page = watch(make_context(**kw).new_page())
    page.goto(fg.url)
    page.wait_for_selector("#main h1", timeout=15000)
    settle(page)
    return page


def test_forge_example_dossier_page(make_context, fg):
    page = open_page(make_context, fg)
    goto(page, f"#/p/{fg.pid}/main/forge")
    assert page.locator("[data-testid=forge-list] .forge-empty").is_visible()
    page.click("[data-testid=forge-example]")
    page.wait_for_selector("[data-testid=forge-page] .forge-name", timeout=15000)
    settle(page, 600)
    assert page.inner_text(".forge-name").strip().upper() == "MOKI VEY"
    assert "THE MAN WHO HOLDS THE LINE" in page.inner_text(".forge-tagline")
    assert page.inner_text("[data-testid=forge-readiness]") == "DRAFT"
    page.wait_for_function("() => document.querySelectorAll('[data-testid=forge-views] img').length === 10", timeout=15000)
    page.wait_for_selector("[data-testid=forge-portrait] img", timeout=15000)
    assert page.locator(".forge-section").count() == 14
    assert "01 / Character record" in page.inner_text(".forge-section >> nth=0")
    assert page.locator("[data-testid=forge-card][data-status=proposed]").count() > 100
    assert page.locator("[data-key=supplied_canon] .forge-badge.lock").count() == 1
    shot(page, "forge-dossier")
    # the letter filter: only cards with an F
    page.click(".forge-chip[data-letter=F]")
    tags = page.locator("[data-testid=forge-card] .forge-tags").all_inner_texts()
    assert tags and all("F" in t for t in tags)
    page.click(".forge-chip.all")
    # ✔ Approve one proposal, ✎ edit another
    page.click("[data-key=wants] [data-testid=approve-one]")
    page.wait_for_selector("[data-key=wants][data-status=approved]", timeout=10000)
    page.locator("[data-key=fear]").hover()
    page.click("[data-key=fear] [data-testid=edit-one]")
    page.fill("#fe-fear", "Being held still while a machine fails.")
    page.click("[data-testid=save-one]")
    page.wait_for_selector("[data-key=fear][data-status=approved]", timeout=10000)
    assert "Being held still" in page.inner_text("[data-key=fear]")
    # ✔ Approve all → READY
    page.click("[data-testid=forge-approve-all]")
    page.click("dialog[open] button.primary")
    page.wait_for_function("() => document.querySelector('[data-testid=forge-readiness]').textContent === 'READY'",
                           timeout=10000)
    assert "REV 4" in page.inner_text("[data-testid=forge-code]")
    # ⬇ Dossier PDF
    with page.expect_download(timeout=20000) as dl:
        page.click("[data-testid=forge-pdf]")
    assert dl.value.suggested_filename.endswith("Character Forge dossier.pdf")
    assert not bad_text(page) and not unnamed_controls(page)
    assert_clean(page, "dossier page")
    # the list shows the tile; the character card links here
    goto(page, f"#/p/{fg.pid}/main/forge")
    page.wait_for_selector("[data-testid=forge-tile]")
    rid = page.get_attribute("[data-testid=forge-tile]", "data-rid")
    assert "CH-001" in page.inner_text("[data-testid=forge-tile]") and "READY" in page.inner_text("[data-testid=forge-tile]")
    goto(page, f"#/p/{fg.pid}/main/rec/{rid}")
    page.wait_for_selector("[data-testid=open-forge]", timeout=15000)
    page.click("[data-testid=open-forge]")
    page.wait_for_selector("[data-testid=forge-page] .forge-name", timeout=15000)
    assert_clean(page, "list and character card")


def test_forge_page_fits_a_phone(make_context, fg):
    from akowe import forge_example
    out = forge_example.load(fg.app, "author", fg.pid, "main", {})
    page = open_page(make_context, fg, width=390, height=844)
    goto(page, f"#/p/{fg.pid}/main/forge/{out['record_id']}")
    page.wait_for_function("() => document.querySelectorAll('[data-testid=forge-views] img').length === 10", timeout=15000)
    settle(page, 300)
    assert overflow(page) <= 1
    shot(page, "forge-dossier-phone")
    assert_clean(page, "phone")


def _poster_of(jpg_path) -> bytes:
    """A 4:5 first frame cut from the example portrait (what a picture→video clip of it starts with), as PNG."""
    import io
    from PIL import Image
    im = Image.open(jpg_path).convert("RGB")
    w, hgt = im.size
    top = int(hgt * 0.04)
    buf = io.BytesIO()
    im.crop((0, top, w, min(hgt, top + int(w * 1.25)))).save(buf, "PNG")
    return buf.getvalue()


def _webm_of(poster_png: bytes, tmp_path) -> bytes:
    """A real 1-second WebM of the poster (ffmpeg, when there is one) so the screenshot shows a playable clip; else
    WebM-looking bytes (the poster still shows; the player marks the clip as not playable)."""
    import shutil
    import subprocess
    from test_forge_clip import WEBM
    exe = shutil.which("ffmpeg")
    if exe:
        src, out = tmp_path / "poster.png", tmp_path / "clip.webm"
        src.write_bytes(poster_png)
        try:
            subprocess.run([exe, "-y", "-loglevel", "error", "-loop", "1", "-i", str(src), "-t", "1", "-r", "12",
                            "-vf", "scale=240:-2,format=yuv420p", "-c:v", "libvpx", "-b:v", "300k", str(out)],
                           check=True, timeout=60)
            return out.read_bytes()
        except (OSError, subprocess.SubprocessError):
            pass
    return WEBM


def test_forge_motion_clip_player(make_context, fg, tmp_path):
    """🎬 The motion study under the portrait: Make the motion clip (progress while AutoInjector works, through a fake
    bridge), then the looping, muted <video> with its poster; the author's own clip replaces it."""
    from akowe import forge, forge_example
    from test_forge import png
    from test_forge_clip import FakeVideoBridge
    out = forge_example.load(fg.app, "author", fg.pid, "main", {})
    rid = out["record_id"]
    (tmp_path / "videos").mkdir()
    b = FakeVideoBridge(tmp_path / "videos")
    b.delay = 2.0
    b.poster = _poster_of(forge_example.EXAMPLE_DIR / "portrait.jpg")
    b.video = _webm_of(b.poster, tmp_path)
    forge.save_bridge_settings(fg.app, {"url": b.url, "token": "t"})
    try:
        page = open_page(make_context, fg)
        goto(page, f"#/p/{fg.pid}/main/forge/{rid}")
        page.wait_for_selector("[data-testid=forge-motion]", timeout=15000)
        assert "MOTION STUDY" in page.inner_text("[data-testid=forge-motion] h3").upper()
        assert page.locator("[data-testid=forge-clip]").count() == 0
        assert page.is_enabled("[data-testid=clip-make]") and page.is_visible("[data-testid=clip-upload]")
        page.click("[data-testid=clip-make]")
        page.wait_for_selector("[data-testid=clip-progress] .spinner", timeout=5000)  # progress while it runs
        page.wait_for_function("() => /making the motion clip/i.test(document.querySelector('[data-testid=clip-progress]').textContent)",
                               timeout=5000)
        page.wait_for_function("() => { const v = document.querySelector('[data-testid=forge-clip]');"
                               " return v && (v.getAttribute('poster') || '').startsWith('blob:') && v.src.startsWith('blob:'); }",
                               timeout=20000)
        v = page.locator("[data-testid=forge-clip]")
        for attr in ("loop", "muted", "playsinline", "controls"):
            assert v.get_attribute(attr) is not None, attr
        assert page.evaluate("() => { const v = document.querySelector('[data-testid=forge-clip]');"
                             " return v.loop && v.muted && v.controls; }")
        assert b.requests[0]["purpose"] == "clip" and b.requests[0]["seconds"] == 4
        assert "wan22-ti2v-5b" in page.inner_text("[data-testid=forge-motion]")
        settle(page, 500)
        page.locator("[data-testid=forge-motion]").scroll_into_view_if_needed()
        shot(page, "forge-motion-clip")
        try:  # the hero alone, for the docs (best effort)
            from .ui_helpers import SHOTS
            page.locator(".forge-hero").screenshot(path=str(SHOTS / "forge-motion-hero.png"))
        except Exception:  # noqa: BLE001
            pass
        assert not unnamed_controls(page)
        assert_clean(page, "motion clip")
        # a picture is not a clip: the page says so before anything is sent
        with page.expect_file_chooser() as fc:
            page.click("[data-testid=clip-upload]")
        fc.value.set_files({"name": "still.png", "mimeType": "image/png", "buffer": png()})
        page.wait_for_selector("[data-testid=forge-motion] .state.problem, [data-testid=forge-motion] .problem", timeout=5000)
        assert "MP4 and WebM" in page.inner_text("[data-testid=forge-motion]")
    finally:
        b.close()


def test_new_character_from_the_forge_list(make_context, fg):
    """🧑 ＋ New character: a character the book does not have yet, with its dossier (POST /forge/characters)."""
    from akowe import characters as chars_mod
    page = open_page(make_context, fg)
    goto(page, f"#/p/{fg.pid}/main/forge")
    page.wait_for_selector("[data-testid=forge-new-name]", timeout=15000)
    page.click("[data-testid=forge-new]")  # no name: asks for one, nothing is made
    assert not chars_mod.canon_characters(fg.app.store, fg.pid, "main")
    page.fill("[data-testid=forge-new-name]", "Ada Quill")
    page.fill("[data-testid=forge-new-role]", "the harbour master")
    page.click("[data-testid=forge-new]")
    page.wait_for_selector("[data-testid=forge-page] .forge-name", timeout=15000)
    assert page.inner_text(".forge-name").lower() == "ada quill" and "CH-001" in page.inner_text("[data-testid=forge-code]")
    c = chars_mod.canon_characters(fg.app.store, fg.pid, "main")
    assert [x["name"] for x in c] == ["Ada Quill"] and not c[0]["approved"]
    assert not bad_text(page) and not unnamed_controls(page)
    assert_clean(page, "new character")
