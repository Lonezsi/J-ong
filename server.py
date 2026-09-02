#!/usr/bin/env python3
"""Start J-ong.

    python server.py              the library at http://127.0.0.1:7900
    python server.py --port 8080  somewhere else
    python server.py --open       and open a browser at it

Standard library only, so there is nothing to install and nothing to keep in step.
"""
import sys
import argparse
import webbrowser

from jong import config, http, registry


def main(argv=None):
    parser = argparse.ArgumentParser(description="J-ong, a personal music workspace")
    parser.add_argument("--host", default=config.HOST)
    parser.add_argument("--port", type=int, default=config.PORT)
    parser.add_argument("--open", action="store_true", help="open a browser once it is up")
    args = parser.parse_args(argv)

    server = http.serve(args.host, args.port)
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
    print("\nCtrl-C to stop.")

    if args.open:
        webbrowser.open(where)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
