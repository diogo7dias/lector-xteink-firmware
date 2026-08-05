# Lector Xteink Firmware

A single-page, in-browser hub for the [Lector / CrossPoint](https://github.com/diogo7dias/lector)
Xteink X3 / X4 e-ink reader. Two tools, no uploads:

- **Flasher** — install the **Lector** firmware (C++ core with memory-safe Rust helpers)
  over USB (Web Serial): an app-only Update, or a full install for a new device.
- **Converter** — turn any image into a sleep wallpaper as a device-ready **`.pxc`** (packed
  2-bit) or **`.bmp`** (2-bit grayscale) file.
- **Cleaner** — repair wallpapers that were converted *before* the dithering below, and so carry
  stray pixels scattered over their flat areas.

**→ Live tool: https://diogo7dias.github.io/lector-wallpaper-converter/**

Everything runs locally in the browser via an HTML canvas. No image is ever uploaded.

## Use

1. Pick your **screen** — `X4 · 480×800` (the standard build) or `X3 · 528×792`.
2. Pick the **format** — `PXC` or `BMP`.
3. Drop in one or more images. The best rendering settings are detected per image.
4. Download, copy the files into `/sleep` on the SD card.
5. On the device: **Settings → Sleep Screen = Custom**, and **Wallpaper Format** = whatever you exported.

Files must match the screen size within 1&nbsp;px or the device rejects them — that is why the
screen selector matters.

## What "auto" does

- **Rendering** — measures the image's tonal range. Photographs (many tones) get dithering for
  smooth gradients; logos / line art / text (few tones) get crisp thresholding.
- **Auto-contrast** — stretches tones across all four gray levels so flat images aren't muddy.
- **Fit** — *Cover* fills and crops (default), *Fit* letterboxes, *Stretch* distorts.
- **Invert** — only if a wallpaper renders like a photo negative on your panel.

## Dithering

The panel's four levels are 85 grays apart, so a single mis-fired pixel lands a whole step away from
its neighbours rather than blending in. Plain Floyd–Steinberg produces exactly that on a large area
whose tone sits near, but not on, one of the four levels: the residual error has nowhere to go, so it
accumulates until it tips one pixel to the next level, over and over. On a near-white background it
reads as grit. Measured on a flat field of gray 245, Floyd–Steinberg fired 462 stray mid-gray pixels
in every 4,096.

Three changes bring that to zero without flattening the image:

- **Atkinson diffusion** hands on six eighths of each error instead of all of it, so a residual decays
  rather than building without limit.
- **A serpentine scan** alternates row direction, breaking up the diagonal streaks a one-way pass
  leaves behind.
- **A flat-field snap** places an area that is both locally flat and within 28 grays of a level onto
  that level, discarding its error. Flatness is measured on a blurred copy so that sensor grain does
  not read as detail, *and* on the raw pixels so that a line thinner than the blur kernel is never
  mistaken for a flat field and smoothed away.

A tone genuinely between two levels still dithers, because snapping it would misreport the image. The
trade is deliberate and worth knowing: two flat areas that are both within 28 grays of the same level
now render as the same solid level, where before they differed by the density of their grit.

## Cleaner

Wallpapers converted before the above keep their speckle, and re-converting them is not always
possible — the original photo may be long gone. The **Cleaner** tab and
[`scripts/clean_pxc.py`](scripts/clean_pxc.py) work on the finished file instead: they unpack a `.pxc`
or 2-bit `.bmp` to level indices, replace each lone stray pixel with the level its neighbours agree
on, and pack the result back at the same size in the same format. Nothing is re-scaled and no tone is
re-mapped.

A pixel is treated as speckle only when at least seven of its eight neighbours share one level and the
pixel itself is a different level. A genuine one-pixel line is therefore safe: its neighbours along
the line carry its own level, so no neighbourhood ever reaches a seven-of-eight majority against it.

The browser tab handles about 100 files at a time. For a whole SD card, use the script:

```sh
# Look first. Change nothing.
python3 scripts/clean_pxc.py /Volumes/LECTOR/sleep --dry-run

# Write cleaned copies to a separate folder (the default, and the safe one).
python3 scripts/clean_pxc.py /Volumes/LECTOR/sleep -o ~/Desktop/cleaned

# Overwrite the originals. Asks for confirmation and keeps a .bak beside each file.
python3 scripts/clean_pxc.py /Volumes/LECTOR/sleep --in-place
```

Python 3.8+, no third-party packages. It uses every CPU core by default: about five minutes for 5,000
528×792 files on a modern laptop, against roughly half an hour single-threaded.

## Format notes

`.pxc`: 4-byte little-endian `width,height` header, then 2 bits/pixel (levels 0–3 = gray
0/85/170/255), MSB-first, row stride `(width+3)/4`. `.bmp`: standard bottom-up 2-bit bitmap with a
4-entry grayscale palette. Both match the device decoder (`PxcSleepRenderer.cpp` / `Bitmap.cpp`)
byte-for-byte.

## Gallery

The **Gallery** tab shares 3,190 ready-made wallpapers stored as sequentially named `.pxc` files in
[`gallery/`](gallery/). Original X3 (528×792) and X4 (480×800) bytes are preserved exactly. The page
shows one 24-preview page at a time to keep memory and network use bounded, offers each original master as-is,
and re-targets to the other screen or to `.bmp` locally on demand.

Run `node scripts/import-gallery.mjs ~/Downloads` to rebuild the gallery from a folder tree. The importer
finds `.pxc` files recursively, validates X3/X4 dimensions, removes exact byte duplicates from the import,
sorts deterministically, copies masters as `0001.pxc` onward, and regenerates the manifest. It reports
source duplicates but never deletes source files.

The gallery loads over http (the live site or a local server); the Converter tab still works fully
offline.

Offline-capable: save the page and it still works with no network.
