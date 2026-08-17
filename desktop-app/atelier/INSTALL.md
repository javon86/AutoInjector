# ATELIER Installation

## Requirements
- Python 3.11+ recommended.
- Git installed for repository/ref and transaction verification.
- No Python package installation is required for the current standard-library toolchain.

## Install
1. Extract the release ZIP. It contains one top-level `ATELIER/` directory.
2. Keep the directory layout intact; the flat root is load-bearing for the current suites.
3. From `ATELIER/`, run:

   `python clean_verify.py`

4. Require every suite to report `PASS` before using the installation as a verified baseline.
5. Run the end-to-end seam check:

   `python harness.py e2e`

6. Create a book project only after verification:

   `python init_project.py "Book Title" --chapters 20`

A timeout, missing suite, or non-zero verification result is a failed installation, not a warning.
