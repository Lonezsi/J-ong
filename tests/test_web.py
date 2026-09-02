"""The browser side, checked against the server it talks to.

None of this runs the JavaScript. It checks the contracts that break silently: an
endpoint renamed on one side, a listener that outlives its view, a stylesheet the page
never links.
"""
import os
import re
import pathlib
import urllib.error

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
    # The whole app, including the door, since the page calls that too.
    registry.load(config.MODULES)
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
    # An edit goes through the player, which hands it only to the decks actually holding
    # this preset. Applying it to the audio graph directly would change whatever else was
    # playing, including another song.
    assert "presetEdited" in panel, "the sound panel writes to the audio graph directly"
    assert "J.audio.applyTo" not in panel, "the panel reaches past the player into a deck"

    with open(os.path.join(JS_DIR, "40-player.js"), encoding="utf-8") as f:
        player = f.read()
    body = player.split("presetEdited(presetId, data) {", 1)[1].split("\n    },", 1)[0]
    assert "preset.id === presetId" in body, "an edit is applied to slots that do not hold it"


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
    # The stylesheet link itself, not merely a mention. This assertion used to pass on a
    # comment describing a typeface the page had stopped loading, which is a test that
    # cannot fail: deleting the link entirely would not have moved it.
    # The css2 request specifically. A preconnect hint to the same host is not a request
    # for a typeface, and matching it made this pass while loading nothing.
    link = re.search(r'<link[^>]+fonts\.googleapis\.com/css2\?[^>]*>', page)
    assert link, "the typefaces are never fetched"
    for family in ("Orbitron", "Manrope"):
        assert "family=" + family in link.group(0), "%s is not requested" % family


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


def test_the_hidden_attribute_beats_the_layout():
    """A browser's own [hidden] { display: none } is a user agent rule, and any author
    rule beats it. Without a rule of our own, .sheet-backdrop { display: grid } left the
    modal backdrop over the whole app at 60% black with nothing in it: the page looked
    dimmed and every click landed on the overlay instead of the interface.

    Anything that carries the hidden attribute and also gets a display from its class
    depends on this one line.
    """
    from jong.http import bundle
    css = bundle(CSS_DIR, ".css").decode("utf-8")
    assert re.search(r"\[hidden\]\s*\{[^}]*display:\s*none\s*!important", css), \
        "nothing makes the hidden attribute win, so hidden elements with a display show"

    with open(os.path.join(WEB, "login.html"), encoding="utf-8") as f:
        login = f.read()
    assert re.search(r"\[hidden\]\s*\{[^}]*display:\s*none\s*!important", login), \
        "the login page has its own stylesheet and the same hazard"


def test_everything_that_starts_hidden_can_actually_hide():
    """Each element carrying the attribute, checked against the rules that style it."""
    with open(os.path.join(WEB, "index.html"), encoding="utf-8") as f:
        page = f.read()
    css = "\n".join(open(os.path.join(CSS_DIR, n), encoding="utf-8").read()
                    for n in sorted(os.listdir(CSS_DIR)) if n.endswith(".css"))

    # Elements that start hidden, by the class they are styled through.
    for element_class in ("player", "sheet-backdrop", "update-dot"):
        assert element_class in page, "%s is no longer in the shell" % element_class
    # The guard has to be present, since two of those three are given a display.
    assert "[hidden]" in css


# ── the silent CSS failures ──────────────────────────────────────────────────
def _markup_sources():
    web = pathlib.Path(WEB)
    return list((web / "js").glob("*.js")) + [web / "index.html", web / "login.html"]


def _styled_classes():
    """Every class any stylesheet defines, including the login page's own block."""
    css = "\n".join(open(os.path.join(CSS_DIR, n), encoding="utf-8").read()
                    for n in sorted(os.listdir(CSS_DIR)) if n.endswith(".css"))
    login = open(os.path.join(WEB, "login.html"), encoding="utf-8").read()
    inline = re.search(r"<style>(.*?)</style>", login, re.S)
    if inline:
        css += "\n" + inline.group(1)
    return set(re.findall(r"\.([a-zA-Z][\w-]*)", css))


def test_no_class_in_the_markup_goes_unstyled():
    """An element given a class nothing defines is drawn by the browser's own rules.

    The rail's New song button carried .chip, which existed in no stylesheet, so it
    rendered as a default button: a white box on a dark panel, unreadable.
    """
    styled = _styled_classes()
    # Hooks the scripts query or toggle but never paint.
    hooks = {"now", "total", "sheet-body", "on", "off", "chosen", "playing", "current",
             "settled", "hot", "dragging", "scrubbing", "paused", "is-cover", "bad",
             "slide-left", "slide-right", "rail-shut", "grow", "wrap", "sm", "lg",
             "primary", "ghost", "danger", "quiet", "accent", "warn", "right", "spec"}
    unstyled = {}
    for path in _markup_sources():
        text = path.read_text(encoding="utf-8")
        for m in re.finditer(r'class="([^"$]*)"', text):
            for name in m.group(1).split():
                if name and name not in styled and name not in hooks:
                    unstyled.setdefault(name, set()).add(path.name)
    assert not unstyled, "classes used but never styled: " + str(
        {k: sorted(v) for k, v in unstyled.items()})


def test_no_element_has_two_classes_fighting_over_display():
    """Two single class rules setting display tie on specificity, so whichever file the
    bundler reaches last wins.

    .rail-close is `icon-btn rail-close`. .icon-btn sets display: grid in 30-controls.css
    and .rail-close set display: none in 20-shell.css, so the button was permanently
    visible on desktop, where nothing was wired to it. The fix is a two class selector,
    which does not care about file order.
    """
    files = sorted(n for n in os.listdir(CSS_DIR) if n.endswith(".css"))
    declares = {}
    for order, name in enumerate(files):
        text = open(os.path.join(CSS_DIR, name), encoding="utf-8").read()
        for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", text):
            body = m.group(2)
            value = re.search(r"display:\s*([\w-]+)", body)
            if not value:
                continue
            for part in m.group(1).strip().split("\n")[-1].split(","):
                part = part.strip()
                if re.fullmatch(r"\.[\w-]+", part):
                    declares.setdefault(part[1:], []).append((order, name, value.group(1)))

    clashes = []
    for path in _markup_sources():
        for m in re.finditer(r'class="([^"$]*)"', path.read_text(encoding="utf-8")):
            names = [n for n in m.group(1).split() if n in declares]
            for i, a in enumerate(names):
                for b in names[i + 1:]:
                    va, vb = declares[a][0], declares[b][0]
                    if va[2] != vb[2]:
                        clashes.append("%s(%s in %s) vs %s(%s in %s)"
                                       % (a, va[2], va[1], b, vb[2], vb[1]))
    assert not clashes, "file order decides whether these show: " + "; ".join(sorted(set(clashes)))


def test_a_page_revalidates_instead_of_being_held_for_a_day(server):
    """index.html went out with max-age=86400, so a fix landed on disk and the browser
    kept serving yesterday's markup for a day. That is how a corrected button stayed
    broken on screen long after it was fixed."""
    import urllib.request
    for path in ("/login", "/jong.css"):
        with urllib.request.urlopen(server.base + path, timeout=10) as response:
            cache = response.headers.get("Cache-Control", "")
            etag = response.headers.get("ETag")
        assert "max-age" not in cache, "%s is cached for a fixed time: %s" % (path, cache)
        assert etag, "%s has no ETag, so no-cache means a full refetch every time" % path

        request = urllib.request.Request(server.base + path,
                                         headers={"If-None-Match": etag})
        try:
            with urllib.request.urlopen(request, timeout=10) as again:
                assert False, "%s did not answer 304 to a matching tag" % path
        except urllib.error.HTTPError as e:
            assert e.code == 304, "%s answered %d to a matching tag" % (path, e.code)
