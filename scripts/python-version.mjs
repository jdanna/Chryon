// Single source of truth for the pinned CPython version, shared by
// download-python.mjs (downloads/verifies the interpreter itself) and
// vendor-python-packages.mjs (needs the same version's ABI tag to download
// cross-platform wheels via pip's --python-version/--implementation/--abi
// flags -- see that script for why). A plain data module rather than
// exporting this from download-python.mjs directly: that script performs a
// real network download as an unconditional side effect at import time, so
// importing it just to read a constant would trigger that download.
export const PYTHON_VERSION = '3.14.4'
