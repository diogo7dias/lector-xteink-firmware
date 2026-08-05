#!/usr/bin/env python3
"""Remove error-diffusion speckle from already-converted Lector wallpapers.

The reader's panel shows four grey levels, 85 steps apart. When a wallpaper is
produced with plain Floyd-Steinberg dithering, a large area whose tone sits near
but not exactly on one of those levels accumulates residual error until it tips a
single pixel a whole level away from its neighbours. On a white or otherwise flat
background that reads as grit.

This script repairs finished files. It does not re-scale, re-map tones or
re-dither: it unpacks a .pxc or 2-bit .bmp to level indices, replaces each lone
stray pixel with the level its neighbours agree on, and packs the result back at
the same size in the same format.

A pixel is treated as speckle only when at least seven of its eight neighbours
share one level and the pixel itself is a different level. A genuine one-pixel
line is therefore safe, because its neighbours along the line carry its own
level and no neighbourhood ever reaches a seven-of-eight majority against it.

Usage:

    # Look, change nothing. Always start here.
    python3 clean_pxc.py /Volumes/LECTOR/sleep --dry-run

    # Write the cleaned copies into a separate folder (the default, and safe).
    python3 clean_pxc.py /Volumes/LECTOR/sleep -o ~/Desktop/cleaned

    # Overwrite the originals on the card. Keeps a .bak beside each file.
    python3 clean_pxc.py /Volumes/LECTOR/sleep --in-place

    # Overwrite with no backup. Only with a copy of the card elsewhere.
    python3 clean_pxc.py /Volumes/LECTOR/sleep --in-place --no-backup

Requires Python 3.8 or newer. No third-party packages.
"""

from __future__ import annotations

import argparse
import multiprocessing
import os
import shutil
import struct
import sys
from pathlib import Path

LEVELS = (0, 85, 170, 255)

# How many of the eight neighbours must agree before a pixel is called speckle.
# Eight is the strictest setting and only removes fully isolated pixels; seven
# also catches a stray sitting against an edge of its flat field.
DEFAULT_MAJORITY = 7


def nearest_level(value: float) -> int:
    """Map a 0..255 grey to the index of the closest of the four panel levels."""
    if value >= 212:
        return 3
    if value >= 127:
        return 2
    if value >= 42:
        return 1
    return 0


# ---------------------------------------------------------------- pxc


def decode_pxc(data: bytes):
    """Return (width, height, bytearray of level indices), or None if malformed."""
    if len(data) < 4:
        return None
    width, height = struct.unpack_from("<HH", data, 0)
    if not (1 <= width <= 4096 and 1 <= height <= 4096):
        return None
    stride = (width + 3) >> 2
    if len(data) < 4 + stride * height:
        return None
    idx = bytearray(width * height)
    for y in range(height):
        row = 4 + y * stride
        base = y * width
        for x in range(width):
            idx[base + x] = (data[row + (x >> 2)] >> (6 - ((x & 3) << 1))) & 3
    return width, height, idx


def encode_pxc(width: int, height: int, idx: bytearray) -> bytes:
    stride = (width + 3) >> 2
    out = bytearray(4 + stride * height)
    struct.pack_into("<HH", out, 0, width, height)
    for y in range(height):
        row = 4 + y * stride
        base = y * width
        for x in range(width):
            out[row + (x >> 2)] |= idx[base + x] << (6 - ((x & 3) << 1))
    return bytes(out)


# ---------------------------------------------------------------- bmp


def decode_bmp(data: bytes):
    """Unpack a 2-bit, uncompressed BMP. Returns (width, height, idx) or None.

    The palette is read rather than assumed, so a file whose four entries are
    stored in a different order still maps onto our level indices correctly.
    """
    if len(data) < 54 or data[0:2] != b"BM":
        return None
    pixel_offset = struct.unpack_from("<I", data, 10)[0]
    header_size = struct.unpack_from("<I", data, 14)[0]
    width, raw_height = struct.unpack_from("<ii", data, 18)
    bpp = struct.unpack_from("<H", data, 28)[0]
    compression = struct.unpack_from("<I", data, 30)[0]
    if bpp != 2 or compression != 0:
        return None
    height, top_down = abs(raw_height), raw_height < 0
    if not (1 <= width <= 4096 and 1 <= height <= 4096):
        return None
    row_bytes = (((width * 2) + 31) >> 5) << 2
    if len(data) < pixel_offset + row_bytes * height:
        return None

    palette = []
    for i in range(4):
        p = 14 + header_size + i * 4
        if p + 2 < len(data):
            blue, green, red = data[p], data[p + 1], data[p + 2]
            palette.append(nearest_level(0.299 * red + 0.587 * green + 0.114 * blue))
        else:
            palette.append(i)

    idx = bytearray(width * height)
    for y in range(height):
        src_y = y if top_down else height - 1 - y
        row = pixel_offset + y * row_bytes
        base = src_y * width
        for x in range(width):
            idx[base + x] = palette[(data[row + (x >> 2)] >> (6 - ((x & 3) << 1))) & 3]
    return width, height, idx


def encode_bmp(width: int, height: int, idx: bytearray) -> bytes:
    row_bytes = (((width * 2) + 31) >> 5) << 2
    data_size = row_bytes * height
    pixel_offset = 14 + 40 + 16
    size = pixel_offset + data_size
    out = bytearray(size)
    out[0:2] = b"BM"
    struct.pack_into("<I", out, 2, size)
    struct.pack_into("<I", out, 10, pixel_offset)
    struct.pack_into("<I", out, 14, 40)
    struct.pack_into("<ii", out, 18, width, height)
    struct.pack_into("<HH", out, 26, 1, 2)
    struct.pack_into("<I", out, 34, data_size)
    struct.pack_into("<II", out, 46, 4, 4)
    for i in range(4):
        p = 54 + i * 4
        grey = LEVELS[i]
        out[p] = out[p + 1] = out[p + 2] = grey
        out[p + 3] = 0
    for y in range(height):
        src_y = height - 1 - y  # BMP rows are stored bottom-up
        row = pixel_offset + y * row_bytes
        base = src_y * width
        for x in range(width):
            out[row + (x >> 2)] |= (idx[base + x] & 3) << (6 - ((x & 3) << 1))
    return bytes(out)


# ---------------------------------------------------------------- cleaning


def despeckle(width: int, height: int, idx: bytearray, majority: int) -> tuple[bytearray, int]:
    """Return (cleaned copy, number of pixels changed).

    Every neighbour is read from the input, so the pass is simultaneous: a pixel
    that is corrected cannot pull the pixel next to it along with it. The border
    row and column are left alone, because a pixel there has no full
    neighbourhood to be judged against.
    """
    out = bytearray(idx)
    changed = 0
    for y in range(1, height - 1):
        above = (y - 1) * width
        here = y * width
        below = (y + 1) * width
        for x in range(1, width - 1):
            counts = [0, 0, 0, 0]
            counts[idx[above + x - 1]] += 1
            counts[idx[above + x]] += 1
            counts[idx[above + x + 1]] += 1
            counts[idx[here + x - 1]] += 1
            counts[idx[here + x + 1]] += 1
            counts[idx[below + x - 1]] += 1
            counts[idx[below + x]] += 1
            counts[idx[below + x + 1]] += 1
            best = counts.index(max(counts))
            if counts[best] >= majority and idx[here + x] != best:
                out[here + x] = best
                changed += 1
    return out, changed


def clean_file(path: Path, majority: int):
    """Return (cleaned bytes, pixels changed) or None when the file is unreadable."""
    data = path.read_bytes()
    is_bmp = path.suffix.lower() == ".bmp"
    decoded = decode_bmp(data) if is_bmp else decode_pxc(data)
    if decoded is None:
        return None
    width, height, idx = decoded
    cleaned, changed = despeckle(width, height, idx, majority)
    if changed == 0:
        return data, 0
    encoded = encode_bmp(width, height, cleaned) if is_bmp else encode_pxc(width, height, cleaned)
    return encoded, changed


# ---------------------------------------------------------------- cli


def _worker(job):
    """Pool entry point: clean one file and hand the bytes back to the parent.

    Only the cleaning runs in the worker. Writing stays in the parent process, so
    a cancelled run cannot leave half the files written by one process and half
    by another, and the on-screen report stays in file order.
    """
    path, majority = job
    try:
        result = clean_file(path, majority)
    except OSError as err:
        return path, None, 0, str(err)
    if result is None:
        return path, None, 0, "not a readable .pxc or 2-bit .bmp"
    encoded, changed = result
    return path, encoded, changed, None


def gather(target: Path, recursive: bool) -> list[Path]:
    if target.is_file():
        return [target]
    pattern = "**/*" if recursive else "*"
    return sorted(
        p for p in target.glob(pattern)
        if p.is_file() and p.suffix.lower() in (".pxc", ".bmp")
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Remove dithering speckle from converted Lector wallpapers.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Usage:", 1)[1] if "Usage:" in __doc__ else None,
    )
    parser.add_argument("target", type=Path, help="a .pxc/.bmp file, or a folder of them")
    parser.add_argument("-o", "--output", type=Path,
                        help="folder to write cleaned copies into (default: <target>/cleaned)")
    parser.add_argument("--in-place", action="store_true",
                        help="overwrite the originals instead of writing copies")
    parser.add_argument("--no-backup", action="store_true",
                        help="with --in-place, do not keep a .bak of each original")
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would change and write nothing")
    parser.add_argument("--majority", type=int, default=DEFAULT_MAJORITY, choices=(7, 8),
                        help="neighbours that must agree before a pixel is speckle (default 7; "
                             "8 is stricter and removes only fully isolated pixels)")
    parser.add_argument("--no-recursive", action="store_true",
                        help="do not descend into sub-folders")
    parser.add_argument("-j", "--jobs", type=int, default=0,
                        help="how many CPU cores to use (default: all of them; 1 disables "
                             "parallel work, which is easier to read when debugging)")
    args = parser.parse_args(argv)

    target: Path = args.target
    if not target.exists():
        print(f"error: {target} does not exist", file=sys.stderr)
        return 1

    files = gather(target, not args.no_recursive)
    if not files:
        print(f"No .pxc or .bmp files found under {target}")
        return 0

    if args.in_place and not args.dry_run:
        backup_note = "a .bak copy is kept beside each file" if not args.no_backup \
            else "NO BACKUP WILL BE KEPT"
        print("About to overwrite the original files in place.")
        print(f"Folder: {target}")
        print(f"Files:  {len(files)}")
        print(f"Backup: {backup_note}")
        answer = input("Type yes to continue: ").strip().lower()
        if answer != "yes":
            print("Cancelled. Nothing was written.")
            return 1

    out_dir = None
    if not args.in_place and not args.dry_run:
        out_dir = args.output or (target if target.is_dir() else target.parent) / "cleaned"
        out_dir.mkdir(parents=True, exist_ok=True)

    root = target if target.is_dir() else target.parent
    # Do not re-clean our own output on a second run over the same folder.
    if out_dir is not None:
        files = [p for p in files if out_dir not in p.parents]

    jobs = args.jobs if args.jobs > 0 else (os.cpu_count() or 1)
    jobs = max(1, min(jobs, len(files)))
    if jobs > 1:
        print(f"Cleaning {len(files)} files across {jobs} cores.")
        with multiprocessing.Pool(jobs) as pool:
            reports = pool.map(_worker, [(p, args.majority) for p in files],
                               chunksize=max(1, len(files) // (jobs * 8)))
    else:
        reports = [_worker((p, args.majority)) for p in files]

    total_changed = 0
    touched = 0
    skipped = 0

    for i, (path, encoded, changed, error) in enumerate(reports, 1):
        if error is not None:
            skipped += 1
            print(f"[{i}/{len(files)}] {path.name}: skipped ({error})")
            continue
        total_changed += changed
        if changed:
            touched += 1

        if args.dry_run:
            print(f"[{i}/{len(files)}] {path.name}: {changed} pixels would be cleaned")
            continue
        if changed == 0:
            print(f"[{i}/{len(files)}] {path.name}: already clean")
            if out_dir is not None:
                shutil.copy2(path, out_dir / path.name)
            continue

        if args.in_place:
            if not args.no_backup:
                backup = path.with_suffix(path.suffix + ".bak")
                if not backup.exists():
                    shutil.copy2(path, backup)
            path.write_bytes(encoded)
            print(f"[{i}/{len(files)}] {path.name}: {changed} pixels cleaned (overwritten)")
        else:
            relative = path.relative_to(root) if root in path.parents or root == path.parent else Path(path.name)
            destination = out_dir / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(encoded)
            print(f"[{i}/{len(files)}] {path.name}: {changed} pixels cleaned -> {destination}")

    print()
    print(f"Done. {len(files)} files read, {touched} changed, {total_changed} pixels cleaned"
          + (f", {skipped} skipped" if skipped else "") + ".")
    if args.dry_run:
        print("This was a dry run. Nothing was written.")
    elif out_dir is not None:
        print(f"Cleaned copies are in {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
