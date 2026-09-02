"""The browser side, checked against the server it talks to.

None of this runs the JavaScript. It checks the contracts that break silently: an
endpoint renamed on one side, a listener that outlives its view, a stylesheet the page
never links.
"""
import os
import re

import pytest

from jong import config, registry
from jong.http import resolve

WEB = config.WEB
JS_DIR = os.path.join(WEB, "js")
CSS_DIR = os.path.join(WEB, "css")


def _all_js():
    parts = []
    for name in sorted(os.listdir(JS_DIR)):
        if name.endswith(".js"):
            with open(os.path.join(JS_DIR, name), encoding="utf-8") as f:
                parts.append((name, f.read()))
    return parts


def _js():
    return "\n".join(text for _, text in _all_js())


def test_every_endpoint_the_page_calls_exists():
    """A renamed route shows up as a section of the page that is silently empty on a
    machine in another room. Only a test notices."""
    text = _js()
    called = set()
    # The path has to be captured through the ${id} in a template literal, not stopped
    # at it, or every route with an id in the middle reads as one that does not exist.
    for pattern in (r'J\.(?:get|post|put|patch|del|upload)\(\s*[`"\']([^`"\']+)',
                    r'J\.api\(\s*[`"\']([^`"\']+)',
                    r'fetch\(\s*[`"\']([^`"\']+)'):
        called.update(re.findall(pattern, text))

    # Template literals carry an id in the middle; the shape is what matters.
    def normalise(path):
        path = re.sub(r"\$\{[^{}]*\}", "1", path)
        # A nested template (a ${...} containing its own backticks) cannot be matched by
        # a regex. Everything before it is still a real route prefix, so cut there.
        if "${" in path:
            path = path.split("${")[0]
        return path.split("?")[0].rstrip("/")

    missing = []
    for raw in sorted(called):
        path = normalise(raw)
        if not path.startswith("/api/"):
            continue
        found = any(resolve(method, path)[0] for method in
                    ("GET", "POST", "PUT", "PATCH", "DELETE"))
        if not found:
            missing.append(path)
    assert not missing, "the page calls endpoints the server does not have: %s" % missing


def test_the_endpoints_each_feature_needs_are_still_called():
    """Named one by one, so deleting a chunk of a view fails here rather than quietly
    reducing what the app can do."""
    text = _js()
    for path in ("/api/state", "/api/songs", "/api/songs/${", "/api/versions/${",
                 "/api/albums", "/api/sync/scan", "/api/sync/import",
                 "/api/update/check", "/api/update/apply", "/api/settings"):
        assert path in text, "nothing calls %s any more" % path


def test_the_router_replaces_the_view_rather_than_emptying_it():
    """Views attach delegated click handlers to the view node. Emptying it left every
    previous view's handler attached: after six navigations one click on Play started
    playback six times over and the concurrent starts fought each other."""
    with open(os.path.join(JS_DIR, "80-router.js"), encoding="utf-8") as f:
        router = f.read()
    assert "replaceWith" in router, "the router reuses the view node, so listeners pile up"
    body = router.split("async function go()", 1)[1]
    assert 'createElement("div")' in body


def test_listeners_on_the_bus_let_go_when_their_panel_is_gone():
    """A subscription outlives the DOM it draws, so it has to unhook itself."""
    with open(os.path.join(JS_DIR, "64-panel-versions.js"), encoding="utf-8") as f:
        panel = f.read()
    assert "removeEventListener" in panel, "the versions panel subscribes forever"


def test_the_eq_reads_the_response_without_touching_playback():
    """The sound panel is reachable for a song that is not playing. Computing its curve
    from the live chain would have made the display wrong, or worse, changed the sound of
    whatever else was playing."""
    with open(os.path.join(JS_DIR, "30-eq.js"), encoding="utf-8") as f:
        eq = f.read()
    assert "responseOf(data.bands" in eq, "the curve is read off the live chain"

    with open(os.path.join(JS_DIR, "66-panel-sound.js"), encoding="utf-8") as f:
        panel = f.read()
    assert "isLive()" in panel, "edits are pushed to the player regardless of what is playing"


def test_adding_a_band_does_not_rebuild_the_canvas():
    """An earlier version redrew the whole panel when a band was added, which replaced
    the canvas under the pointer: you could add a node but never add one and drag it."""
    with open(os.path.join(JS_DIR, "66-panel-sound.js"), encoding="utf-8") as f:
        panel = f.read()
    handler = panel.split('if (what === "add")', 1)[1].split("\n", 1)[0]
    assert "renderBands()" in handler and "draw()" not in handler


def test_the_page_asks_the_server_what_exists_before_drawing_it():
    """Switching a module off in config has to remove it from the interface too, or the
    UI shows a button that returns 404."""
    with open(os.path.join(JS_DIR, "60-view-song.js"), encoding="utf-8") as f:
        song = f.read()
    assert "J.state.modules.includes" in song, "the song page assumes every module is on"


# ── the shell ────────────────────────────────────────────────────────────────
def test_the_page_links_what_the_server_bundles():
    with open(os.path.join(WEB, "index.html"), encoding="utf-8") as f:
        page = f.read()
    assert '"/jong.css"' in page and '"/jong.js"' in page
    assert "fonts.googleapis.com" in page, "the typefaces are never fetched"
    for family in ("Syne", "Manrope"):
        assert family in page


def test_the_bundles_are_not_empty():
    from jong.http import bundle
    css = bundle(CSS_DIR, ".css")
    js = bundle(JS_DIR, ".js")
    assert len(css) > 4000, "the stylesheet bundle is suspiciously small"
    assert len(js) > 20000, "the script bundle is suspiciously small"
    assert b"J.views.library" in js


def test_every_view_file_registers_a_view():
    """A file in js/ that defines nothing is a file that should have been deleted."""
    for name, text in _all_js():
        if "-view-" in name:
            assert re.search(r"J\.views\.\w+\s*=", text), "%s registers no view" % name


def test_the_css_only_spends_tokens_on_colour():
    """One accent, set in one place. A literal colour in a component is how a design
    system stops being one."""
    allowed = {"transparent", "currentColor", "inherit", "none", "cover"}
    offenders = []
    for name in sorted(os.listdir(CSS_DIR)):
        if not name.endswith(".css") or name.startswith("00-"):
            continue
        with open(os.path.join(CSS_DIR, name), encoding="utf-8") as f:
            for number, line in enumerate(f, 1):
                if line.strip().startswith("/*") or line.strip().startswith("*"):
                    continue
                for literal in re.findall(r"#[0-9a-fA-F]{3,8}\b", line):
                    offenders.append("%s:%d %s" % (name, number, literal))
    # A handful of one-off shades are tolerable; a drift into hardcoded colour is not.
    assert len(offenders) <= 4, "colours are being written by hand: %s" % offenders


def test_the_modules_the_ui_expects_are_the_modules_that_exist():
    registry.load()
    text = _js()
    named = set(re.findall(r'modules\.includes\("(\w+)"\)', text))
    unknown = named - set(config.MODULES)
    assert not unknown, "the UI checks for modules that do not exist: %s" % unknown
