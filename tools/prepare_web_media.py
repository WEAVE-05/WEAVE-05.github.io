#!/usr/bin/env python3
"""Create resumable web derivatives without changing the original research media.

Requires ffmpeg/ffprobe on PATH and Pillow with WebP support. Source provenance,
hashes and encoding diagnostics stay in the ignored _local directory. Only the
allowlisted gallery schema and relative media paths are published.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import hashlib
import io
import json
from pathlib import Path
import shutil
import struct
import subprocess
import time

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
MATERIALS = ROOT / "_local/materials"
CATALOG = MATERIALS / "catalog/cases.json"
PRIVATE = ROOT / "_local/web-media"
MEDIA = ROOT / "media"
MANIFEST = ROOT / "data/gallery.json"
SHOWCASE = ROOT / "data/showcase.json"
POSTER_TIME = 1.0
# Stable public aliases are never renumbered when changing presentation order.
LEAD_CASES = {"joint": "joint-007"}
TASKS = {
    "joint": {
        "title": "Joint generation",
        "description": "RGB views with depth, edges and segmentation across the same scene.",
    },
    "newview": {
        "title": "Cross-view completion",
        "description": "Generate complementary wrist views conditioned on the observed main-view video.",
    },
    "c2v": {
        "title": "Modality-conditioned generation",
        "description": "Generate RGB videos conditioned on a depth, edge or segmentation video.",
    },
    "v2c": {
        "title": "Visual modality prediction",
        "description": "Predict depth, edges or segmentation conditioned on observed RGB videos.",
    },
}


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    tmp.replace(path)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe(path: Path) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=codec_name,width,height,pix_fmt,avg_frame_rate,nb_frames,duration:format=duration",
         "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    )
    raw = json.loads(result.stdout)
    video = raw["streams"][0]
    numerator, denominator = video["avg_frame_rate"].split("/")
    return {
        "codec": video["codec_name"], "width": video["width"], "height": video["height"],
        "pixel_format": video.get("pix_fmt"), "fps": float(numerator) / float(denominator),
        "frames": int(video["nb_frames"]),
        "duration": float(video.get("duration", raw["format"]["duration"])),
    }


def faststart(path: Path) -> bool:
    """Check MP4 top-level atoms without mistaking payload bytes for atom names."""
    atoms = []
    total = path.stat().st_size
    with path.open("rb") as handle:
        while handle.tell() + 8 <= total:
            header = handle.read(8)
            size, name = struct.unpack(">I4s", header)
            header_size = 8
            if size == 1:
                size = struct.unpack(">Q", handle.read(8))[0]
                header_size = 16
            elif size == 0:
                size = total - handle.tell() + 8
            if size < header_size:
                return False
            atoms.append(name)
            handle.seek(size - header_size, 1)
    return b"moov" in atoms and b"mdat" in atoms and atoms.index(b"moov") < atoms.index(b"mdat")


def slug(stream: dict) -> str:
    view = int(stream["view"])
    prefix = "main" if view == 0 else f"wrist-{view}"
    return f"{prefix}-{stream['modality']}"


def stream_label(stream: dict) -> str:
    if stream["modality"] == "rgb":
        return "Main RGB" if int(stream["view"]) == 0 else f"Wrist {stream['view']} RGB"
    return {"depth": "Depth", "edge": "Edges", "seg": "Segmentation"}[stream["modality"]]


def all_jobs() -> tuple[list, list]:
    cases = json.loads(CATALOG.read_text())
    with (MATERIALS / "catalog/video_inventory.csv").open(newline="") as handle:
        inventory = {row["path"]: row for row in csv.DictReader(handle)}
    assert len({case["id"] for case in cases}) == len(cases), "Duplicate case IDs"
    counters = {task: 0 for task in TASKS}
    indexed_cases, jobs = [], []
    for case in cases:
        task = case["task"]
        counters[task] += 1
        public_id = f"{task}-{counters[task]:03d}"
        indexed = {"raw": case, "public_id": public_id, "number": counters[task], "jobs": []}
        used_names = set()
        for stream in case["streams"]:
            source = (MATERIALS / stream["path"]).resolve()
            if not source.is_relative_to((MATERIALS / "source").resolve()) or not source.is_file():
                raise ValueError(f"Missing or unsafe source: {source}")
            name = slug(stream)
            assert name not in used_names, f"Duplicate stream name for {public_id}: {name}"
            used_names.add(name)
            dest = MEDIA / task / public_id / f"{name}.mp4"
            job = {"source": source, "dest": dest, "poster": dest.with_suffix(".webp"),
                   "case_id": case["id"], "public_id": public_id, "task": task, "stream": stream,
                   "expected_source_sha256": inventory[stream["path"]]["sha256"]}
            indexed["jobs"].append(job)
            jobs.append(job)
        indexed_cases.append(indexed)
    assert len({str(job["source"]) for job in jobs}) == len(jobs), "Sources unexpectedly shared"
    return indexed_cases, jobs


def encode(source: Path, dest: Path, width: int, crf: int, preset: str, threads: int) -> float:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.stem + ".part.mp4")
    # No -r, trimming, interpolation or cropping: retain all frames and timestamps.
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-xerror", "-nostdin", "-y", "-threads", str(threads),
        "-i", str(source), "-map", "0:v:0", "-map_metadata", "-1", "-an", "-sn", "-dn",
        "-vf", f"scale='min({width},iw)':-2:flags=lanczos,setsar=1", "-c:v", "libx264",
        "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p", "-profile:v", "high",
        "-level:v", "3.1", "-threads", str(threads), "-g", "32", "-fps_mode", "passthrough",
        "-movflags", "+faststart", str(tmp),
    ]
    started = time.monotonic()
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"ffmpeg failed: {source}\n{result.stderr[-3000:]}")
    tmp.replace(dest)
    return time.monotonic() - started


def make_poster(video: Path, poster: Path) -> None:
    # Use the same timestamp in every stream; the video itself still starts at 0.
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1",
         "-ss", str(POSTER_TIME), "-i", str(video), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"],
        check=True, capture_output=True,
    )
    with Image.open(io.BytesIO(result.stdout)) as image:
        image.convert("RGB").save(poster, "WEBP", quality=78, method=4)


def validate(source_probe: dict, output_probe: dict, path: Path) -> None:
    assert source_probe["frames"] == output_probe["frames"], f"Frame mismatch: {path}"
    assert abs(source_probe["fps"] - output_probe["fps"]) < 1e-8, f"FPS mismatch: {path}"
    assert abs(source_probe["duration"] - output_probe["duration"]) < 0.001, f"Duration mismatch: {path}"
    assert output_probe["codec"] == "h264" and output_probe["pixel_format"] == "yuv420p"
    assert faststart(path), f"Not faststart: {path}"
    a = source_probe["width"] / source_probe["height"]
    b = output_probe["width"] / output_probe["height"]
    assert abs(a - b) < 0.01, f"Aspect ratio changed: {path}"


def process_job(job: dict, args: argparse.Namespace) -> dict:
    source, dest, poster = job["source"], job["dest"], job["poster"]
    cache = PRIVATE / "records" / job["task"] / job["public_id"] / f"{dest.stem}.json"
    recipe = {"width": args.width, "crf": args.crf, "preset": args.preset, "threads": args.threads,
              "codec": "libx264", "pixel_format": "yuv420p", "gop": 32, "version": 1}
    source_hash = sha256(source)
    if source_hash != job["expected_source_sha256"]:
        raise RuntimeError(f"Original source changed since inventory audit: {source}")
    if cache.is_file() and dest.is_file() and poster.is_file() and not args.force:
        saved = json.loads(cache.read_text())
        if (saved.get("source_sha256") == source_hash and saved.get("recipe") == recipe
                and saved.get("output_sha256") == sha256(dest)
                and saved.get("poster_sha256") == sha256(poster)):
            if saved.get("poster_time") != POSTER_TIME:
                if args.verify_only:
                    raise RuntimeError(f"Stale poster timestamp: {poster}")
                make_poster(dest, poster)
                saved["poster_time"] = POSTER_TIME
                saved["poster_sha256"] = sha256(poster)
                saved["poster_bytes"] = poster.stat().st_size
                write_json(cache, saved)
            return saved
    if args.verify_only:
        raise RuntimeError(f"Missing or stale derivative/cache: {dest}")
    source_probe = probe(source)
    elapsed = encode(source, dest, args.width, args.crf, args.preset, args.threads)
    output_probe = probe(dest)
    validate(source_probe, output_probe, dest)
    make_poster(dest, poster)
    saved = {
        "case_id": job["case_id"], "public_id": job["public_id"], "task": job["task"],
        "source": str(source.relative_to(ROOT)), "source_sha256": source_hash,
        "output": str(dest.relative_to(ROOT)), "output_sha256": sha256(dest),
        "poster": str(poster.relative_to(ROOT)), "poster_sha256": sha256(poster),
        "poster_time": POSTER_TIME,
        "source_bytes": source.stat().st_size, "output_bytes": dest.stat().st_size,
        "poster_bytes": poster.stat().st_size, "encoding_seconds": round(elapsed, 3),
        "source_probe": source_probe, "output_probe": output_probe, "recipe": recipe,
    }
    write_json(cache, saved)
    return saved


def gallery(indexed_cases: list, records: dict | None = None) -> dict:
    # Public IDs are based on source order, while presentation order prioritizes
    # complete selected bundles. Neither the scores nor their labels are emitted.
    sorted_cases = sorted(indexed_cases, key=lambda c: (
        list(TASKS).index(c["raw"]["task"]),
        0 if c["public_id"] == LEAD_CASES.get(c["raw"]["task"]) else 1,
        0 if c["raw"]["selection"] == "all_good" else 1,
        c["number"],
    ))
    labels = {}
    if SHOWCASE.is_file():
        curated = json.loads(SHOWCASE.read_text())
        lookup = {case["public_id"]: case for case in indexed_cases}
        sorted_cases = []
        for task in TASKS:
            for selection in curated["tasks"][task]:
                public_id = selection["id"]
                if public_id in labels or public_id not in lookup:
                    raise ValueError(f"Unknown or repeated showcase ID: {public_id}")
                if lookup[public_id]["raw"]["task"] != task:
                    raise ValueError(f"Showcase task mismatch: {public_id}")
                labels[public_id] = {key: selection[key] for key in ("robot", "dataset", "environment")
                                     if isinstance(selection.get(key), str) and selection[key].strip()}
                sorted_cases.append(lookup[public_id])
    result = {"version": 2, "tasks": TASKS, "cases": []}
    for indexed in sorted_cases:
        case = indexed["raw"]
        entry = {"id": indexed["public_id"], "task": case["task"],
                 "title": f"Example {indexed['number']:03d}", "prompt": case["prompt"], "streams": []}
        entry.update(labels.get(indexed["public_id"], {}))
        for job in indexed["jobs"]:
            stream = job["stream"]
            output = str(job["dest"].relative_to(ROOT))
            if records and output in records:
                media_probe = records[output]["output_probe"]
            else:
                raw = stream["probe"]
                numerator, denominator = raw["avg_frame_rate"].split("/")
                media_probe = {"width": raw["width"], "height": raw["height"],
                               "fps": float(numerator) / float(denominator),
                               "frames": int(raw["nb_frames"]), "duration": float(raw["duration"])}
            entry["streams"].append({
                "src": output, "poster": str(job["poster"].relative_to(ROOT)),
                "posterTime": POSTER_TIME,
                "label": stream_label(stream), "kind": "input" if stream["is_clean"] else "output",
                "modality": stream["modality"], "view": stream["view"],
                **{key: media_probe[key] for key in ("width", "height", "fps", "frames", "duration")},
            })
        result["cases"].append(entry)
    return result


def benchmark(jobs: list, args: argparse.Namespace) -> None:
    selected = []
    for modality in ("rgb", "depth", "edge", "seg"):
        group = sorted([j for j in jobs if j["stream"]["modality"] == modality],
                       key=lambda j: j["stream"]["bytes"])
        selected.append(group[len(group) // 2])
        if modality == "rgb":
            selected.extend([group[-1], group[len(group) // 4]])
    directory = PRIVATE / "benchmark"
    results = []
    candidates = [(640, 28), (640, 30), (480, 28)]

    def run(item: tuple) -> dict:
        index, job, width, crf = item
        name = f"{index:02d}-{job['stream']['modality']}-{width}-crf{crf}"
        dest = directory / f"{name}.mp4"
        elapsed = encode(job["source"], dest, width, crf, args.preset, args.threads)
        output_probe = probe(dest)
        source_probe = probe(job["source"])
        validate(source_probe, output_probe, dest)
        make_poster(dest, dest.with_suffix(".webp"))
        return {"source": str(job["source"].relative_to(ROOT)), "modality": job["stream"]["modality"],
                "width": width, "crf": crf, "source_bytes": job["source"].stat().st_size,
                "output_bytes": dest.stat().st_size, "seconds": round(elapsed, 3),
                "duration": output_probe["duration"], "output": str(dest.relative_to(ROOT))}

    items = [(index, job, width, crf) for index, job in enumerate(selected) for width, crf in candidates]
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for result in pool.map(run, items):
            results.append(result)
            print(json.dumps(result), flush=True)
    write_json(directory / "results.json", results)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark", action="store_true")
    parser.add_argument("--manifest-only", action="store_true", help="Write paths for UI development before encoding")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--decode-check", action="store_true", help="Also decode every output video to EOF")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--width", type=int, choices=(480, 640), default=640)
    parser.add_argument("--crf", type=int, default=28)
    parser.add_argument("--preset", default="medium")
    parser.add_argument("--workers", type=int, choices=(1, 2, 3, 4), default=4)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--limit", type=int, help="Encode only the first N jobs for development")
    args = parser.parse_args()
    for command in ("ffmpeg", "ffprobe"):
        if not shutil.which(command):
            parser.error(f"{command} not found on PATH")
    indexed_cases, jobs = all_jobs()
    if args.manifest_only:
        public_gallery = gallery(indexed_cases)
        write_json(MANIFEST, public_gallery)
        print(f"Wrote gallery: {len(public_gallery['cases'])} selected cases, "
              f"{sum(len(case['streams']) for case in public_gallery['cases'])} streams")
        return
    if args.benchmark:
        benchmark(jobs, args)
        return
    if args.limit:
        jobs = jobs[:args.limit]
    # Current gallery's first joint example comes first, so the UI is reviewable early.
    order = {entry["id"]: i for i, entry in enumerate(gallery(indexed_cases)["cases"])}
    jobs.sort(key=lambda job: order.get(job["public_id"], len(order)))
    started = time.monotonic()
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(process_job, job, args): job for job in jobs}
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            results.append(result)
            if len(results) % 10 == 0 or len(results) == len(jobs):
                output_mb = sum(row["output_bytes"] + row["poster_bytes"] for row in results) / 1_000_000
                print(f"{len(results)}/{len(jobs)} complete; {output_mb:.1f} MB; "
                      f"{time.monotonic()-started:.1f}s elapsed", flush=True)
    records = {result["output"]: result for result in results}
    if args.decode_check:
        def decode(record: dict) -> None:
            output = ROOT / record["output"]
            result = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-xerror", "-nostdin", "-threads", "1",
                 "-i", str(output), "-map", "0:v:0", "-f", "null", "-"],
                capture_output=True, text=True,
            )
            if result.returncode:
                raise RuntimeError(f"Decode check failed: {output}\n{result.stderr[-3000:]}")
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            list(pool.map(decode, results))
        print(f"Decoded all {len(results)} output videos to EOF without errors", flush=True)
    if not args.limit:
        write_json(MANIFEST, gallery(indexed_cases, records))
    summary = {"cases": len(indexed_cases), "streams": len(jobs),
               "video_bytes": sum(row["output_bytes"] for row in results),
               "poster_bytes": sum(row["poster_bytes"] for row in results),
               "source_bytes": sum(row["source_bytes"] for row in results),
               "elapsed_seconds": round(time.monotonic() - started, 2),
               "verification_only": args.verify_only, "full_decode_check": args.decode_check,
               "recipe": {"width": args.width, "crf": args.crf, "preset": args.preset},
               "records": results}
    write_json(PRIVATE / ("partial-audit.json" if args.limit else "audit.json"), summary)
    print(json.dumps({key: value for key, value in summary.items() if key != "records"}), flush=True)


if __name__ == "__main__":
    main()
