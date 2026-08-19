# Experiment batch 1: byte-range zeroing on .0000 (Swiss 721 Bold, no edge)

All files below are copies of the original `.0000` with one contiguous byte
range overwritten with zeros. Everything else (header, name, other data) is
untouched. Goal: figure out which byte ranges correspond to which glyphs by
seeing which characters break/disappear/garble on screen.

Load each one, type the SAME sample text as before:

```
ABCDEFGHIJKLM
NOPQRSTUVWXYZ
abcdefghijklm
nopqrstuv
wxyz
1234567890
```

(skip the punctuation line this round — just letters/digits, since that's
what we need to localize) and photograph the result. Label each photo with
the filename so I can match them up.

| file  | zeroed range        | size zeroed |
|-------|----------------------|-------------|
| .9001 | 0x140 - 0x1000        | 3776 bytes  |
| .9002 | 0x1000 - 0x4000       | 12288 bytes |
| .9003 | 0x4000 - 0x8000       | 16384 bytes |
| .9004 | 0x8000 - 0x10000      | 32768 bytes |
| .9005 | 0x10000 - 0x18000     | 32768 bytes |
| .9006 | 0x18000 - end (0x1e74e) | 26446 bytes |

Original `.0000` is 124750 bytes (0x1e74e) total. Header/name/metrics table
occupies roughly 0x0 - 0x140; everything from 0x140 onward is unknown "bulk"
data (hypothesized to be per-glyph outline/raster data).

If a file fails to load at all, or crashes/hangs the unit, stop testing that
one immediately and tell me — that alone is useful info (means that range
holds something structural, not glyph data, e.g. a table the loader
validates).
