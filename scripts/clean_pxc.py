#!/usr/bin/env python3
"""Remove error-diffusion speckle from already-converted Lector wallpapers.

The reader's panel shows four grey levels, 85 steps apart. When a wallpaper is
produced with plain Floyd-Steinberg dithering, a large area whose tone sits near
but not exactly on one of those levels accumulates residual error until it tips a
single pixel a whole level away from its neighbours. On a white or otherwise flat
background that reads as grit.

This script repairs finished files. It does not re-scale, re-map tones or
re-dither: it unpacks a .pxc or 2-bit .bmp to level indices, fills in the stray
specks, and packs the result back at the same size in the same format.

A speck is an island of at most a few same-level pixels sitting completely
enclosed by one single other level. Lines and shapes are safe because they are
one large island, whatever their width: even a hairline one pixel across is long,
so its island exceeds the size cap and none of it can be touched. Running the
cleaner twice changes nothing the first run left.

Point it at the SD card and it cleans the files where they lie, so there is
nothing to copy back afterwards. Each original is kept as a .bak beside it until
you are happy with the result. The reader ignores those: its sleep-folder scan
matches the last four characters of a name against .pxc or .bmp, and a .bak ends
in neither.

Usage:

    # Simplest. A window opens, you pick the folder, it cleans it.
    python3 clean_pxc.py

    # The same thing with the folder given directly.
    python3 clean_pxc.py /Volumes/LECTOR/sleep

    # Look first, change nothing.
    python3 clean_pxc.py /Volumes/LECTOR/sleep --dry-run

    # Same, without being asked to confirm.
    python3 clean_pxc.py /Volumes/LECTOR/sleep --yes

    # No .bak copies. Only do this with the card backed up elsewhere.
    python3 clean_pxc.py /Volumes/LECTOR/sleep --no-backup

    # Leave the originals alone and write cleaned copies somewhere else.
    python3 clean_pxc.py /Volumes/LECTOR/sleep -o ~/Desktop/cleaned

    # Delete the .bak files once you have checked the wallpapers on the reader.
    python3 clean_pxc.py /Volumes/LECTOR/sleep --drop-backups

Requires Python 3.8 or newer. No third-party packages.
"""

from __future__ import annotations

import argparse
import multiprocessing
import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path

LEVELS = (0, 85, 170, 255)

# The largest island of same-level pixels still treated as speckle. Anything
# bigger is left alone.
#
# Judging each pixel by its own neighbours is the obvious approach and it is
# wrong. The last pixel of a line has seven background neighbours and one of its
# own level, so any neighbour-counting rule eats it, then eats the new last pixel
# on the next run, and a line shrinks from its ends every time the cleaner is
# used. Measuring the island instead fixes that completely: a line is one long
# island, so its size exceeds the cap and every pixel in it is safe no matter how
# often the pass repeats. It also catches what neighbour-counting misses, namely
# the two- and three-pixel clumps that error diffusion drops next to each other.
DEFAULT_MAX_SPECKLE = 4


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


def despeckle(width: int, height: int, idx: bytearray, max_speckle: int) -> tuple[bytearray, int]:
    """Return (cleaned copy, number of pixels changed).

    An island of up to max_speckle same-level pixels that is completely enclosed
    by one single other level is speckle, and is filled with that surrounding
    level. Both conditions matter. The size cap is what protects lines and
    shapes, as described by DEFAULT_MAX_SPECKLE. Requiring one uniform
    surrounding level is what keeps the pass to flat areas: a few stray pixels
    sitting on a boundary between two levels are part of the picture's structure,
    not grit on a background, and are left alone.

    The border row and column are never removed, because a pixel there has no
    full neighbourhood to be judged against.

    Islands are found by flood fill, and the fill stops as soon as it passes the
    cap, so a long line costs a handful of steps rather than a walk of its whole
    length. Every read is from the input, so the pass is simultaneous.
    """
    out = bytearray(idx)
    seen = bytearray(width * height)
    changed = 0

    for y in range(1, height - 1):
        row = y * width
        for x in range(1, width - 1):
            start = row + x
            if seen[start]:
                continue
            level = idx[start]

            # Grow the island, abandoning it the moment it is too big to be grit.
            island = [start]
            seen[start] = 1
            head = 0
            too_big = False
            while head < len(island):
                p = island[head]
                head += 1
                py, px = divmod(p, width)
                for dy in (-1, 0, 1):
                    ny = py + dy
                    if not 0 <= ny < height:
                        continue
                    for dx in (-1, 0, 1):
                        nx = px + dx
                        if (dx == 0 and dy == 0) or not 0 <= nx < width:
                            continue
                        q = ny * width + nx
                        if idx[q] == level and not seen[q]:
                            seen[q] = 1
                            island.append(q)
                if len(island) > max_speckle:
                    too_big = True
                    break
            if too_big:
                continue

            # An island touching the border has no full ring around it to judge.
            # Its surroundings must also be a single level, or this is structure.
            #
            # This test is also what makes an abandoned fill safe. When a big
            # island is given up on, the members not yet reached can be seeded
            # again later and look small on their own. They are never removed,
            # because such a fragment always has a neighbour of its own level
            # just outside itself, which is either a surround that equals the
            # island's own level or one that disagrees with the rest.
            members = set(island)
            surround = -1
            enclosed = True
            for p in island:
                py, px = divmod(p, width)
                if px == 0 or py == 0 or px == width - 1 or py == height - 1:
                    enclosed = False
                    break
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        q = (py + dy) * width + (px + dx)
                        if q in members:
                            continue
                        if surround < 0:
                            surround = idx[q]
                        elif idx[q] != surround:
                            enclosed = False
                            break
                    if not enclosed:
                        break
                if not enclosed:
                    break
            if not enclosed or surround < 0 or surround == level:
                continue

            for p in island:
                out[p] = surround
            changed += len(island)

    return out, changed


def clean_file(path: Path, max_speckle: int):
    """Return (cleaned bytes, pixels changed) or None when the file is unreadable."""
    data = path.read_bytes()
    is_bmp = path.suffix.lower() == ".bmp"
    decoded = decode_bmp(data) if is_bmp else decode_pxc(data)
    if decoded is None:
        return None
    width, height, idx = decoded
    cleaned, changed = despeckle(width, height, idx, max_speckle)
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
    path, max_speckle = job
    try:
        result = clean_file(path, max_speckle)
    except OSError as err:
        return path, None, 0, str(err)
    if result is None:
        return path, None, 0, "not a readable .pxc or 2-bit .bmp"
    encoded, changed = result
    return path, encoded, changed, None


def pick_folder() -> Path | None:
    """Ask the user to choose a folder in a window. Returns None if they cancel.

    Two ways are tried, because neither is available everywhere. On macOS the
    system's own chooser is asked for first through osascript: it is always
    present, it looks like every other Finder dialog, and it needs nothing
    installed. Elsewhere, and if that fails, tkinter provides the same thing,
    though some Python builds ship without it.
    """
    if sys.platform == "darwin":
        try:
            completed = subprocess.run(
                ["osascript", "-e",
                 'POSIX path of (choose folder with prompt '
                 '"Choose the folder of wallpapers to clean, '
                 'for example the sleep folder on the SD card:")'],
                capture_output=True, text=True, timeout=300,
            )
            if completed.returncode == 0:
                chosen = completed.stdout.strip()
                if chosen:
                    return Path(chosen)
            # A non-zero exit is normally the user pressing Cancel.
            if "cancel" in (completed.stderr or "").lower():
                return None
        except (OSError, subprocess.SubprocessError):
            pass  # fall through to tkinter

    try:
        import tkinter
        from tkinter import filedialog
    except ImportError:
        return None

    try:
        root = tkinter.Tk()
        root.withdraw()
        root.update()
        chosen = filedialog.askdirectory(title="Choose the folder of wallpapers to clean")
        root.destroy()
    except Exception:
        return None
    return Path(chosen) if chosen else None


def drop_backups(target: Path, recursive: bool) -> int:
    """Delete the .bak files an in-place run left behind, after confirmation.

    Only names of the form <something>.pxc.bak or <something>.bmp.bak are
    considered, so an unrelated .bak the user keeps in that folder is not swept
    up by a wildcard.
    """
    root = target if target.is_dir() else target.parent
    pattern = "**/*.bak" if recursive else "*.bak"
    backups = sorted(
        p for p in root.glob(pattern)
        if p.is_file() and Path(p.stem).suffix.lower() in (".pxc", ".bmp")
    )
    if not backups:
        print(f"No .pxc.bak or .bmp.bak files found under {root}")
        return 0

    freed = sum(p.stat().st_size for p in backups)
    print("The files listed below are the untouched originals from an earlier run.")
    print("Deleting them cannot be undone, and the cleaned files are all that will remain.")
    print(f"Folder:  {root}")
    print(f"Backups: {len(backups)} files, {freed / 1024 / 1024:.1f} MB")
    answer = input("Type delete to remove them: ").strip().lower()
    if answer != "delete":
        print("Cancelled. Nothing was deleted.")
        return 1

    for p in backups:
        p.unlink()
    print(f"Deleted {len(backups)} backup files, freeing {freed / 1024 / 1024:.1f} MB.")
    return 0


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
    parser.add_argument("target", type=Path, nargs="?",
                        help="a .pxc/.bmp file, or a folder of them. Leave it out and a window "
                             "opens for you to choose the folder.")
    parser.add_argument("-o", "--output", type=Path,
                        help="leave the originals alone and write cleaned copies into this folder "
                             "(default: clean the files where they are)")
    parser.add_argument("--in-place", action="store_true",
                        help="accepted and ignored; cleaning in place is now the default")
    parser.add_argument("--no-backup", action="store_true",
                        help="do not keep a .bak of each original (they are kept by default)")
    parser.add_argument("-y", "--yes", action="store_true",
                        help="do not ask for confirmation before overwriting")
    parser.add_argument("--drop-backups", action="store_true",
                        help="delete the .bak files left by an earlier run and do nothing else")
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would change and write nothing")
    parser.add_argument("--max-speckle", type=int, default=DEFAULT_MAX_SPECKLE, metavar="N",
                        help=f"largest island of same-level pixels still treated as speckle "
                             f"(default {DEFAULT_MAX_SPECKLE}; 1 removes only fully isolated pixels)")
    parser.add_argument("--no-recursive", action="store_true",
                        help="do not descend into sub-folders")
    parser.add_argument("-j", "--jobs", type=int, default=0,
                        help="how many CPU cores to use (default: all of them; 1 disables "
                             "parallel work, which is easier to read when debugging)")
    args = parser.parse_args(argv)

    target: Path | None = args.target
    if target is None:
        print("Choose the folder of wallpapers to clean...")
        target = pick_folder()
        if target is None:
            print("No folder chosen. Nothing was done.")
            print(f"You can also pass the path directly: "
                  f"python3 {Path(sys.argv[0]).name} /Volumes/YOUR_CARD/sleep")
            return 1
        print(f"Chosen: {target}")

    if not target.exists():
        print(f"error: {target} does not exist", file=sys.stderr)
        return 1

    if args.drop_backups:
        return drop_backups(target, not args.no_recursive)

    files = gather(target, not args.no_recursive)
    if not files:
        print(f"No .pxc or .bmp files found under {target}")
        return 0

    # Cleaning where the files already lie is the default, so that pointing this
    # at an SD card is the whole job and nothing has to be copied back. Passing
    # -o opts out and leaves the originals untouched.
    in_place = args.output is None

    if in_place and not args.dry_run:
        print("The files listed below will be cleaned and overwritten where they are.")
        print(f"Folder:  {target}")
        print(f"Files:   {len(files)}")
        if args.no_backup:
            print("Backup:  NONE. The originals will be replaced and cannot be recovered.")
        else:
            print("Backup:  each original is kept beside it as a .bak file.")
            print("         The reader ignores those; delete them later with --drop-backups.")
        if not args.yes:
            answer = input("Type yes to continue: ").strip().lower()
            if answer != "yes":
                print("Cancelled. Nothing was written.")
                return 1

    out_dir = None
    if not in_place and not args.dry_run:
        out_dir = args.output
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
            reports = pool.map(_worker, [(p, args.max_speckle) for p in files],
                               chunksize=max(1, len(files) // (jobs * 8)))
    else:
        reports = [_worker((p, args.max_speckle)) for p in files]

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

        if in_place:
            if not args.no_backup:
                backup = path.with_suffix(path.suffix + ".bak")
                # An existing .bak is the untouched original from an earlier run.
                # Overwriting it with an already-cleaned file would destroy the
                # only copy of the original, so it is left exactly as it is.
                if not backup.exists():
                    shutil.copy2(path, backup)
            path.write_bytes(encoded)
            print(f"[{i}/{len(files)}] {path.name}: {changed} pixels cleaned")
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
        print(f"Cleaned copies are in {out_dir}. The originals were not touched.")
    elif touched and not args.no_backup:
        print("The originals are beside each file as .bak. Check the wallpapers on the reader,")
        print(f"then remove them with:  python3 {Path(sys.argv[0]).name} {target} --drop-backups")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
