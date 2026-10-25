"""python -m akowe            -> start the local workspace server.
python -m akowe selftest   -> run the self-test ("Test everything") and write a report."""
import sys

if len(sys.argv) > 1 and sys.argv[1] == "selftest":
    from .selftest import main as selftest_main
    sys.exit(selftest_main(sys.argv[2:]))

from .server import main

sys.exit(main())
