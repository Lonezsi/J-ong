"""SQLite, with one connection per thread and dictionary rows.

Each module owns its own tables and hands its CREATE statements to the registry, so the
schema is assembled from whatever is switched on rather than written out in one place
that has to be kept in step with the module list.
"""
import os
import sqlite3
import threading

from . import config

_local = threading.local()


def connect():
    """This thread's connection, opened on first use."""
    conn = getattr(_local, "conn", None)
    if conn is not None:
        return conn
    config.ensure_dirs()
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    # WAL lets a long upload read while the UI writes, which is the whole reason a
    # personal tool with one user still needs it: the browser polls while you drag a file in.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA synchronous=NORMAL")
    _local.conn = conn
    return conn


def close():
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
        _local.conn = None


def query(sql, args=()):
    return [dict(r) for r in connect().execute(sql, args).fetchall()]


def one(sql, args=()):
    rows = query(sql, args)
    return rows[0] if rows else None


def run(sql, args=()):
    conn = connect()
    cur = conn.execute(sql, args)
    conn.commit()
    return cur


def insert(table, values):
    """Insert a row and return its id. Column names come from our own code, never input."""
    cols = list(values)
    sql = "INSERT INTO %s (%s) VALUES (%s)" % (
        table, ", ".join(cols), ", ".join("?" for _ in cols))
    return run(sql, tuple(values[c] for c in cols)).lastrowid


def update(table, row_id, values):
    if not values:
        return
    cols = list(values)
    sql = "UPDATE %s SET %s WHERE id = ?" % (table, ", ".join(c + " = ?" for c in cols))
    run(sql, tuple(values[c] for c in cols) + (row_id,))


def apply_schema(statements):
    conn = connect()
    for sql in statements:
        conn.execute(sql)
    conn.commit()


def columns(table):
    return [r["name"] for r in query("PRAGMA table_info(%s)" % table)]


def add_column_if_missing(table, name, decl):
    """The only migration this project needs so far. Rebuilding a table would mean
    moving blobs around, and nothing here has needed that yet."""
    if name not in columns(table):
        run("ALTER TABLE %s ADD COLUMN %s %s" % (table, name, decl))


def reset_for_tests():
    close()
    if os.path.exists(config.DB_PATH):
        os.remove(config.DB_PATH)
