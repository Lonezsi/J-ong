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
    playback six times over and the concurrent starts fought each other.

    Matched on what the router does rather than on the signature it happens to have, so
    adding an argument to go() does not read as the bug coming back.
    """
    with open(os.path.join(JS_DIR, "80-router.js"), encoding="utf-8") as f:
        router = f.read()
    assert "replaceWith" in router, "the router reuses the view node, so listeners pile up"
    body = re.split(r"async function go\(", router, maxsplit=1)[1]
    assert 'createElement("div")' in body, "the router no longer builds a fresh view node"
    # Even the in place refresh has to make a new node; carrying the old one over is
    # exactly how the handlers used to pile up.
    assert body.count('createElement("div")') == 1


def test_listeners_on_the_bus_let_go_when_their_panel_is_gone():
    """A subscription outlives the DOM it draws, so it has to unhook itself.

    Every view that redraws on a player change has to do this, or each visit to a song
    leaves another listener redrawing an element that is no longer on the page.
    """
    for name in ("60-view-song.js",):
        with open(os.path.join(JS_DIR, name), encoding="utf-8") as f:
            text = f.read()
        if 'J.on("player:change"' not in text:
            continue
        assert "removeEventListener" in text, "%s subscribes to the bus forever" % name


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
def _class_lists(text):
    """The literal class names of each element, kept per element.

    Two classes only fight over display when they are on the same element, so these stay
    grouped rather than flattened. Flattening them compared every class in a file against
    every other and reported four hundred imaginary clashes.

    Class attributes here are template literals, so most of them carry a ${...} in the
    middle. An earlier version of this matched class="([^"$]*)" and therefore skipped
    every attribute containing one, which is nearly all of them: .sheet-tab went
    undefined for a whole release and rendered as white default buttons. The expressions
    are stripped and the literal names either side are kept.
    """
    elements = []
    for raw in re.findall(r'class="([^"]*)"', text):
        cleaned, depth, out = raw, 0, []
        i = 0
        while i < len(cleaned):
            if cleaned.startswith("${", i):
                depth += 1
                i += 2
                continue
            if depth:
                if cleaned[i] == "{":
                    depth += 1
                elif cleaned[i] == "}":
                    depth -= 1
                i += 1
                continue
            out.append(cleaned[i])
            i += 1
        names = [n for n in "".join(out).split() if n]
        if names:
            elements.append(names)
    return elements


def _class_names(text):
    """Every literal class name in a file, flattened."""
    return {name for element in _class_lists(text) for name in element}


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
        for name in _class_names(text):
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
        for element in _class_lists(path.read_text(encoding="utf-8")):
            names = [n for n in element if n in declares]
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


def test_editing_an_arrangement_does_not_reschedule_the_audio_on_every_move():
    """Trimming a clip while it plays used to tear down every scheduled source and build
    ten new ones on each pointermove: about seven hundred buffer sources over one drag,
    a three quarter second stall, and audio that restarted continuously while you were
    trying to listen to the edit.

    Every edit therefore goes through resync(), which coalesces, rather than calling
    seek() straight through to the scheduler.
    """
    with open(os.path.join(JS_DIR, "22-arrange.js"), encoding="utf-8") as f:
        arrange = f.read()

    assert "resync()" in arrange, "the coalescing reschedule is gone"
    # The editing methods are the ones that must not reschedule immediately.
    for name in ("move", "duplicate", "remove", "resize", "setTempo", "setOffset"):
        body = re.split(r"\n    %s\(" % name, arrange, maxsplit=1)
        assert len(body) == 2, "%s is no longer an editing method here" % name
        # Up to the next method at the same indentation.
        chunk = re.split(r"\n    \w+\(", body[1], maxsplit=1)[0]
        assert "api.seek(" not in chunk, (
            "%s reschedules straight away; a drag calls it once per frame" % name)


def test_every_control_marked_with_an_action_has_one():
    """A button wired to nothing is the worst kind of broken, because it looks fine.

    The rail's close button and the hamburger both did this once: present, styled,
    pressable, and connected to no code at all. data-act is how a control says what it
    does, so every value that appears in markup has to be matched somewhere.
    """
    used, handled = {}, set()
    for name, text in _all_js():
        for act in re.findall(r'data-act="([a-z-]+)"', text):
            used.setdefault(act, set()).add(name)
        # The three shapes the handlers are written in.
        handled.update(re.findall(r'dataset\.act === "([a-z-]+)"', text))
        handled.update(re.findall(r'\bact === "([a-z-]+)"', text))
        handled.update(re.findall(r'\bwhat === "([a-z-]+)"', text))
        # Nothing here may match the markup itself: an earlier version did, so
        # every action counted as handled simply by existing.
        handled.update(re.findall(r'closest\([\'"]\[data-act=[\'"]([a-z-]+)', text))

    dead = {act: sorted(files) for act, files in used.items() if act not in handled}
    assert not dead, "controls that say they do something and do not: %s" % dead


def test_every_control_a_menu_reaches_for_actually_exists():
    """A menu item that presses a button by selector is only as good as the selector.

    The preset menu reached for [data-act="clone"] when the button is called
    clone-preset, so Duplicate was a menu entry that quietly did nothing. That is the
    same failure as a dead button, arrived at from the other direction: the handler
    exists, the markup exists, and the two do not meet.
    """
    declared, reached = set(), {}
    for name, text in _all_js():
        declared.update(re.findall(r'data-act="([a-z-]+)"(?!\s*\])', text))
        # Selector forms: J.$('[data-act="x"]') and node.querySelector('[data-act="x"]')
        for act in re.findall(r"""querySelector\(\s*['"]\[data-act=['"]([a-z-]+)""", text):
            reached.setdefault(act, set()).add(name)
        for act in re.findall(r"""J\.\$\(\s*['"]\[data-act=['"]([a-z-]+)""", text):
            reached.setdefault(act, set()).add(name)

    missing = {act: sorted(files) for act, files in reached.items() if act not in declared}
    assert not missing, "menus reaching for controls that do not exist: %s" % missing


def test_no_stylesheet_has_an_unbalanced_brace():
    """One stray brace takes every rule after it with it.

    An edit left a single orphan } at the end of 10-base.css. The browser stopped
    parsing there, so every stylesheet concatenated after it was discarded: the shell
    lost its grid and the whole app fell into one stacked column. Nothing looked like a
    CSS syntax error, it looked like the layout had been rewritten.

    Counted rather than parsed, because the failure is always a count.
    """
    broken = {}
    for name in sorted(os.listdir(CSS_DIR)):
        if not name.endswith(".css"):
            continue
        with open(os.path.join(CSS_DIR, name), encoding="utf-8") as f:
            text = f.read()
        # Braces inside comments and strings would confuse this; there are none, and a
        # test that quietly stops counting is worse than one that is slightly strict.
        opened, closed = text.count("{"), text.count("}")
        if opened != closed:
            broken[name] = "%d open, %d closed" % (opened, closed)
    assert not broken, "stylesheets that will stop the parser: %s" % broken


def _members_of_literal(text, at):
    """The names a `return { ... }` literal puts on the object, at its own level only.

    Walked rather than matched line by line, because these modules are written both ways:
    one name per line with a comment above it, and `return { create };` all on one.
    """
    depth, i, names = 0, at, set()
    while i < len(text):
        ch = text[i]
        # Comments and strings are stepped over whole. Every one of these modules
        # documents its members in prose above them, and the last word of a comment line
        # sits exactly where a shorthand member sits: taking those as members would have
        # let this test find "apply" in a paragraph about applying and pass regardless.
        if text.startswith("//", i):
            i = text.find("\n", i)
            if i < 0:
                break
            continue
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = len(text) if end < 0 else end + 2
            continue
        if ch in "\"'`":
            i += 1
            while i < len(text) and text[i] != ch:
                i += 2 if text[i] == "\\" else 1
            i += 1
            continue
        if ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth -= 1
            if depth == 0:
                break
        elif depth == 1 and (ch.isalpha() or ch == "_"):
            word = re.match(r"[A-Za-z_]\w*", text[i:]).group(0)
            after = text[i + len(word):]
            if word in ("get", "set", "async") and re.match(r"\s+[A-Za-z_]", after):
                i += len(word)
                continue
            # A member is followed by its parentheses, its colon, the next comma, the end
            # of the line, or the closing brace when it is the last of `return { one };`.
            follows = after.lstrip(" \t")[:1]
            if follows in ("(", ":", ",", "}", "\r", "\n", ""):
                names.add(word)
            i += len(word)
            continue
        i += 1
    return names


def test_no_module_is_called_for_something_it_does_not_have():
    """A call into a module that lost the name it is called by.

    J.audio.apply went away when A and B became two filter chains, because a sound now
    has to be applied to a deck rather than to the output. The EQ editor kept calling it,
    and the throw landed first thing in commit(), so every drag of a curve died before
    onChange ever ran: the editor drew a new shape and nothing else in the app heard
    about it. Nothing failed loudly. The EQ simply stopped working.

    These are single object modules built by an IIFE that ends in one object literal, so
    what a module has can be read off that literal, and what is asked of it can be read
    off every J.<module>.<name>( in the source.
    """
    surface, wanted = {}, {}
    for name, text in _all_js():
        made = re.search(r"^J\.(\w+)\s*=\s*\(function", text, re.M)
        if made:
            # The literal the IIFE itself returns, which is the one at the outer indent.
            # Not the last "return {" in the file: several of these modules return object
            # literals from inside their own functions, further down.
            opens = re.search(r"^  return \{", text, re.M)
            if opens:
                surface[made.group(1)] = _members_of_literal(text, opens.end() - 1)
        for module, member in re.findall(r"\bJ\.(\w+)\.(\w+)\s*\(", text):
            wanted.setdefault(module, {}).setdefault(member, set()).add(name)

    # A parser that quietly read nothing would make this pass forever, so say out loud
    # how much of the app it managed to read.
    read = sorted(m for m, names in surface.items() if names)
    assert len(read) >= 8, "only read the surface of %s, so this proves little" % read
    assert "audio" in read, "the module this was written for was not read"

    missing = {}
    for module, members in wanted.items():
        if module not in surface or not surface[module]:
            continue                        # not one of these modules, or not readable
        for member, files in members.items():
            if member not in surface[module]:
                missing["J.%s.%s" % (module, member)] = sorted(files)
    assert not missing, "called but not there: %s" % missing


def test_the_lyrics_deck_holds_its_gestures_on_something_that_survives_a_redraw():
    """Swiping the lyrics card worked exactly once, then never again.

    The deck's drag was bound to #deckWindow. Changing card calls go(), which schedules
    draw(), and draw() rewrites block.innerHTML: #deckWindow is a different element
    afterwards and the listeners went in the bin with the old one. The arrows, the dots
    and the keyboard all kept working, because those are delegated on block, which is
    never replaced. Only the drag was bound to the thing that gets thrown away, so the
    failure looked like "swiping breaks the card" rather than like a redraw.

    The rule this encodes: in a panel that redraws itself, listeners belong on the root
    that survives, and the element inside is resolved when the gesture happens.
    """
    text = pathlib.Path(JS_DIR, "62-panel-lyrics.js").read_text(encoding="utf-8")

    body = re.search(r"function wireDrag\(\)\s*\{(.*?)\n  \}", text, re.S)
    assert body, "wireDrag is not shaped the way this test reads it"

    bound = set(re.findall(r"(\w+)\.addEventListener\(", body.group(1)))
    assert bound, "wireDrag binds nothing at all"
    assert bound == {"block"}, (
        "the deck's drag is bound to %s; draw() replaces everything inside block, so a "
        "listener held there survives one redraw at most" % sorted(bound - {"block"}))

    # And the ids inside the redrawn markup must not be captured once and kept.
    kept = re.findall(r"(?:const|let)\s+\w+\s*=\s*J\.\$\(\s*[\"']#deck(?:Window|Track)",
                      body.group(1))
    assert not kept, "the deck elements are resolved once and held across redraws"


def test_no_view_block_reaches_for_a_variable_it_was_never_given():
    """A block is handed its own element and a context, never the view root.

    blockArtwork reached for `root`, which exists in the view's render function and not
    in the block's. The ReferenceError landed inside an async click handler, so it did
    not reach window.onerror and nothing was logged: choosing a cover saved on the
    server and then silently stopped, leaving the header showing the old picture. The
    only symptom was a page that looked like it had ignored you.
    """
    text = pathlib.Path(JS_DIR, "60-view-song.js").read_text(encoding="utf-8")

    blocks = re.findall(r"^J\.(block\w+)\s*=\s*(?:async\s+)?function\s*\(([^)]*)\)",
                        text, re.M)
    assert blocks, "no view blocks found; this test is reading the wrong shape"

    trouble = {}
    for name, params in blocks:
        given = {p.strip() for p in params.split(",") if p.strip()}
        start = text.index("J.%s = " % name)
        nxt = [text.index("J.%s = " % other) for other, _ in blocks
               if other != name and text.index("J.%s = " % other) > start]
        body = text[start:min(nxt) if nxt else len(text)]
        # `root` is the view's, and a block is never handed it.
        if "root" not in given and re.search(r"[^.\w]root\b", body):
            trouble[name] = "reaches for root"
    assert not trouble, "blocks using a name they were not given: %s" % trouble


def test_a_corrected_duration_is_only_written_for_the_file_that_was_decoded():
    """One take's length landed on another take's row.

    loadVersion points the slot at the new version before it sets the element's source,
    so for a moment the element still holds the previous file. A loadedmetadata event
    already in flight arrives with the old file's duration and the new version in the
    slot, and the correction is written against the wrong version.

    Found in a real library: a version stored as 41 seconds whose file is 256, while the
    render row it came from had the right number all along. Nothing failed, and the wrong
    number then drove the scrubber, the length sort and this page's own estimates.
    """
    text = pathlib.Path(JS_DIR, "40-player.js").read_text(encoding="utf-8")

    at = text.index('audio.addEventListener("loadedmetadata"', text.index("tells it once"))
    body = text[at:text.index("});", at)]

    assert "currentSrc" in body, (
        "the correction does not check which file the element actually decoded, so it "
        "can write one version's duration onto another")
    assert body.index("currentSrc") < body.index("J.patch"), \
        "the check has to come before the write, or it is not a guard"
