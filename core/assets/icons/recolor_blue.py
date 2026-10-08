#!/usr/bin/env python3
"""Recolor white/black PNG icon sources to ally blue (#006eeb).

Mirrors:
  buildings - black/  -> buildings - blue/
  symbol/units/       -> symbol/units - blue/
  (fallback: buildings/ when a black source is missing)
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

BLUE_RGB = (0x00, 0x6E, 0xEB)  # #006eeb
ROOT = Path(__file__).resolve().parent

JOBS: list[tuple[Path, Path, Path | None]] = [
    # (primary_src_dir, out_dir, fallback_src_dir)
    (ROOT / "buildings - black", ROOT / "buildings - blue", ROOT / "buildings"),
    (ROOT / "symbol" / "units", ROOT / "symbol" / "units - blue", ROOT / "symbol" / "units - black"),
]


def recolor_png(src: Path, dst: Path) -> None:
    im = Image.open(src).convert("RGBA")
    pixels = im.load()
    assert pixels is not None
    w, h = im.size
    br, bg, bb = BLUE_RGB
    for y in range(h):
        for x in range(w):
            _, _, _, a = pixels[x, y]
            if a > 0:
                pixels[x, y] = (br, bg, bb, a)
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, format="PNG")


def collect_rel_pngs(*dirs: Path) -> list[Path]:
    seen: set[str] = set()
    rels: list[Path] = []
    for d in dirs:
        if not d.is_dir():
            continue
        for p in sorted(d.rglob("*.png")):
            rel = p.relative_to(d)
            key = rel.as_posix()
            if key in seen:
                continue
            seen.add(key)
            rels.append(rel)
    return rels


def run() -> int:
    total = 0
    failures: list[str] = []

    for primary, out_dir, fallback in JOBS:
        if not primary.is_dir() and (fallback is None or not fallback.is_dir()):
            failures.append(f"missing source dirs: {primary} / {fallback}")
            continue

        sources = [primary]
        if fallback is not None:
            sources.append(fallback)
        rels = collect_rel_pngs(*sources)
        if not rels:
            failures.append(f"no PNG sources under {primary}")
            continue

        print(f"{primary.name} -> {out_dir.name} ({len(rels)} files)")
        for rel in rels:
            src = primary / rel
            if not src.is_file() and fallback is not None:
                src = fallback / rel
            if not src.is_file():
                failures.append(f"missing source: {rel.as_posix()}")
                continue
            dst = out_dir / rel
            try:
                recolor_png(src, dst)
                total += 1
            except Exception as exc:  # noqa: BLE001 — report and continue
                failures.append(f"{rel.as_posix()}: {exc}")

    print(f"generated: {total}")
    if failures:
        print("failures:")
        for line in failures:
            print(f"  - {line}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(run())
