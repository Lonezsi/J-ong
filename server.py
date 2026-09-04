#!/usr/bin/env python3
"""Start J-ong.

    python server.py              the library at http://127.0.0.1:7900
    python server.py --port 8080  somewhere else
    python server.py --open       and open a browser at it

Standard library only, so there is nothing to install and nothing to keep in step.
"""
import sys
import argparse
import threading
import webbrowser

from jong import config, http, registry, db


def main(argv=None):
    parser = argparse.ArgumentParser(description="J-ong, a personal music workspace")
    parser.add_argument("--host", default=config.HOST)
    parser.add_argument("--port", type=int, default=config.PORT)
    parser.add_argument("--open", action="store_true", help="open a browser once it is up")
    args = parser.parse_args(argv)

    try:
        server = http.serve(args.host, args.port)
    except OSError as e:
        # Almost always a copy that is already running. Saying so beats a stack trace,
        # and beats starting a second server that fights the first for requests.
        print("J-ong could not take port %d: %s" % (args.port, e))
        print("Something is already serving it. Stop that first, or use --port.")
        return 1
    where = "http://%s:%d" % (args.host, args.port)

    print("J-ong %s" % __import__("jong").__version__)
    print("  library   %s" % where)
    print("  data      %s" % config.DATA)
    print("  modules   %s" % ", ".join(registry.enabled()))
    broken = registry.failures()
    for name, detail in broken.items():
        # A module that failed to load is named out loud. Silently serving a smaller app
        # than the config asked for is how you lose a feature without noticing.
        print("  FAILED    %s" % name)
        print("            " + detail.strip().splitlines()[-1])
    if registry.has("auth"):
        from jong.modules import auth
        if auth.has_password():
            print("  sign in    a password is set")
        else:
            # Printed rather than chosen here. The first password is the owner's to
            # pick, and this code is what stops a stranger picking it first.
            code = auth.setup_code()
            print("\n  No password is set on this library yet.")
            print("  Open %s/login and use this one time setup code:" % where)
            print("\n      %s\n" % code)
            print("  It stops working the moment a password is chosen.")

    print("\nCtrl-C to stop.")

    if args.open:
        webbrowser.open(where)
    # Fold the write-ahead log back in every half minute.
    #
    # A commit under synchronous=NORMAL is not fsynced, so what makes it durable is the
    # checkpoint, and nothing was doing one. The host kills this process outright
    # whenever two health probes miss, which makes a hard kill the ordinary way it dies
    # rather than the exceptional one. Thirty seconds is the most work that can cost.
    stop = threading.Event()

    def keep_flushing():
        while not stop.wait(30):
            try:
                db.checkpoint()
            except Exception:
                pass          # a busy database is not a reason to take the server down

    threading.Thread(target=keep_flushing, name="checkpoint", daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        stop.set()
        server.server_close()
        # This is the one moment nothing else is running, so the log is emptied rather
        # than merely folded back in.
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
