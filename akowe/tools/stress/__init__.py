"""⚡ Make-a-book stress harness (findings only; it never changes product code).

``core`` holds the shared machinery (fault-injecting fake AI, restart / pause / cancel helpers, hang detection, the
✅ / 🟡 / ❌ / ⚠️ classifier, log scans and the report writer); each ``section_<letter>`` module registers its parts and
stress scenarios with ``core.Section``. Run from the ``akowe`` folder::

    python -m tools.stress.run --section A [--parts 1] [--stress a,k] [--seed N]

See README.md in this folder.
"""
