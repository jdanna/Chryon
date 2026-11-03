#!/usr/bin/env python3
"""
Read-only access to the pHILE volume on a MAXINE disk image.

Layout, as found on the 11.01 image (big-endian, 1 KB blocks):

  block 2      root block: 12-byte name, then at 0x18 u32 highest block number, 0x1c bitmap
               block, 0x20 unknown (0x83), 0x24 FLIST block, 0x28 first data block
  block 3      root directory (file 3)
  block 4      free block bitmap (file 1, BITMAP.SYS)
  block 0x84   FLIST (file 2, FLIST.SYS): 128-byte file descriptors, indexed by file number

  File descriptor:
    0x00 u16 mode      bit 3 = directory
    0x0e u16 extents   every file on the 11.01 image has 1, empty files have 0
    0x10 u32 size in bytes
    0x14 u32 start block, then u32 block count, repeating per extent

  Directory entry, 16 bytes: u16 file number, 14-byte name, NUL padded.

File data appears twice on the image, about 0x1590400 bytes apart. Offsets printed here are
the copy the filesystem points to, which is the later one.

  python3 tools/phile.py info  disk.img
  python3 tools/phile.py ls    disk.img [/SYSTEM/PROGRAMS]
  python3 tools/phile.py get   disk.img /SYSTEM/PROGRAMS/PSOS out/PSOS
  python3 tools/phile.py where disk.img /SYSTEM/PROGRAMS/PSOS
"""

import argparse
import mmap
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

BLOCK = 1024
ROOT_BLOCK = 2
FD_SIZE = 128
ROOT_FN = 3


@dataclass
class Entry:
    name: str
    fn: int
    mode: int
    size: int
    extents: list

    @property
    def is_dir(self):
        return bool(self.mode & 8)


class Volume:
    def __init__(self, path):
        self.file = open(path, "rb")
        self.data = mmap.mmap(self.file.fileno(), 0, access=mmap.ACCESS_READ)
        root = self.data[ROOT_BLOCK * BLOCK:(ROOT_BLOCK + 1) * BLOCK]
        self.name = root[:12].split(b"\0")[0].decode("latin1")
        self.blocks, self.bitmap, self.dir_block, self.flist, self.first_data = struct.unpack(">5I", root[0x18:0x2c])
        if self.flist * BLOCK + 2 * FD_SIZE >= len(self.data):
            raise ValueError(f"no pHILE volume in {path}")

    def entry(self, fn, name=""):
        fd = self.data[self.flist * BLOCK + fn * FD_SIZE:self.flist * BLOCK + (fn + 1) * FD_SIZE]
        mode = struct.unpack(">H", fd[:2])[0]
        count = struct.unpack(">H", fd[0xe:0x10])[0]
        size = struct.unpack(">I", fd[0x10:0x14])[0]
        # Extents follow one another, start block then length. A file the firmware grew in pieces has several.
        if 0x14 + 8 * count > 0x70:
            raise NotImplementedError(f"file {fn} has {count} extents, more than its descriptor holds")
        extents = [struct.unpack(">II", fd[0x14 + 8 * i:0x1c + 8 * i]) for i in range(count)]
        return Entry(name, fn, mode, size, extents)

    def read(self, entry):
        out = bytearray()
        for start, blocks in entry.extents:
            out += self.data[start * BLOCK:(start + blocks) * BLOCK]
        return bytes(out[:entry.size])

    def listdir(self, directory):
        raw = self.read(directory)
        for i in range(0, len(raw), 16):
            fn = struct.unpack(">H", raw[i:i + 2])[0]
            name = raw[i + 2:i + 16].split(b"\0")[0].decode("latin1")
            if fn and fn != 0xffff and name and name not in (".", ".."):
                yield self.entry(fn, name)

    def lookup(self, path):
        entry = self.entry(ROOT_FN, "/")
        for part in [p for p in path.split("/") if p]:
            match = next((e for e in self.listdir(entry) if e.name == part), None)
            if match is None:
                raise FileNotFoundError(path)
            entry = match
        return entry

    def walk(self, entry=None, prefix=""):
        entry = entry or self.entry(ROOT_FN, "/")
        for child in self.listdir(entry):
            path = f"{prefix}/{child.name}"
            yield path, child
            if child.is_dir and child.fn > 3:
                yield from self.walk(child, path)


def cmd_info(volume, args):
    print(f"volume   {volume.name}")
    print(f"blocks   {volume.blocks + 1} of {BLOCK} bytes")
    print(f"bitmap   block {volume.bitmap:#x}")
    print(f"flist    block {volume.flist:#x}")
    print(f"data     block {volume.first_data:#x}")


def cmd_ls(volume, args):
    top = volume.lookup(args.path)
    prefix = args.path.rstrip("/")
    for path, entry in volume.walk(top, prefix):
        kind = "d" if entry.is_dir else "-"
        print(f"{kind} {entry.size:>9} {path}")


def cmd_get(volume, args):
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    data = volume.read(volume.lookup(args.path))
    out.write_bytes(data)
    print(f"{args.path}: {len(data)} bytes -> {out}")


def cmd_where(volume, args):
    entry = volume.lookup(args.path)
    for start, blocks in entry.extents:
        print(f"block {start:#x}, {blocks} blocks, offset {start * BLOCK:#x}, {entry.size} bytes")


def main():
    parser = argparse.ArgumentParser(description="Read a MAXINE pHILE volume")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, handler in (("info", cmd_info), ("ls", cmd_ls), ("get", cmd_get), ("where", cmd_where)):
        p = sub.add_parser(name)
        p.add_argument("image")
        if name == "ls":
            p.add_argument("path", nargs="?", default="/")
        if name in ("get", "where"):
            p.add_argument("path")
        if name == "get":
            p.add_argument("out")
        p.set_defaults(handler=handler)
    args = parser.parse_args()
    try:
        args.handler(Volume(args.image), args)
    except (OSError, ValueError, NotImplementedError) as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
