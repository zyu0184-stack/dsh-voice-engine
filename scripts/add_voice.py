#!/usr/bin/env python
"""音色素材处理：转码、转写、挑参考片段、切参考音频。

三种用法，都是把结果 JSON 打到 stdout：

  add_voice.py analyze --src 输入.mp3
      整段转写 + 给出若干可用参考片段候选
  add_voice.py cut --src 输入.mp3 --start 12.3 --end 22.4 --out refs/x.wav
      切一段，降噪 + 响度归一，32 kHz 单声道
  add_voice.py text --src 输入.mp3 --start 12.3 --end 22.4
      只转写某一段，用于核对逐字稿

音频文件本身不落盘到输出目录以外，中间 wav 走系统临时目录。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SR = 32000
DEFAULT_MODEL = "small"
MIN_WINDOW = 7.5
MAX_WINDOW = 12.0
TARGET_WINDOW = 9.5
MIN_COVER = 0.42


def die(message: str, code: int = 1) -> "None":
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    raise SystemExit(code)


def ffmpeg_bin() -> str:
    found = shutil.which("ffmpeg")
    if not found:
        die("ffmpeg 不在 PATH 上")
    return found


def to_wav(src: Path, dst: Path, sr: int = SR) -> None:
    cmd = [
        ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(src), "-vn", "-ac", "1", "-ar", str(sr), str(dst),
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        die(f"ffmpeg 转码失败：{proc.stderr.decode('utf-8', 'replace')[:300]}")


def read_mono(path: Path):
    import numpy as np
    import soundfile as sf

    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    return mono, sr, np


def frame_rms(mono, sr: int, hop: float = 0.05):
    import numpy as np

    n = max(1, int(sr * hop))
    usable = len(mono) - (len(mono) % n)
    frames = mono[:usable].reshape(-1, n)
    rms = np.sqrt((frames ** 2).mean(axis=1) + 1e-12)
    return rms, hop


def transcribe(path: Path, model: str, language: str):
    from faster_whisper import WhisperModel

    engine = WhisperModel(model, device="cpu", compute_type="int8")
    segments, info = engine.transcribe(
        str(path),
        language=language,
        beam_size=1,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400, "speech_pad_ms": 120},
    )
    rows = []
    for seg in segments:
        text = seg.text.strip()
        if text:
            rows.append({
                "start": round(float(seg.start), 2),
                "end": round(float(seg.end), 2),
                "text": text,
            })
    return rows, float(getattr(info, "duration", 0.0) or 0.0)


def merge_runs(rows, gap: float = 0.55):
    """把相邻转写段并成连续说话区间。"""
    runs: list[dict] = []
    for row in rows:
        if runs and row["start"] - runs[-1]["end"] <= gap:
            runs[-1]["end"] = max(runs[-1]["end"], row["end"])
            runs[-1]["text"] += row["text"]
        else:
            runs.append({"start": row["start"], "end": row["end"], "text": row["text"]})
    return runs


def pick_candidates(mono, sr: int, rows, limit: int = 8):
    """在转写段里滑动取样，挑出语音密、时长合适、文本完整的窗口。

    能量阈值用低分位做基准：短视频/带节拍的素材整体起伏大，用 p95 当基准会
    把大半语音判成静音。
    """
    import numpy as np

    if not rows:
        return []

    rms, hop = frame_rms(mono, sr)
    p25 = float(np.percentile(rms, 25))
    p95 = float(np.percentile(rms, 95))
    speech_level = max(p25 * 1.6, p95 * 0.12, 1e-4)
    voiced = rms > speech_level

    runs = merge_runs(rows, gap=1.2)
    pool: list[dict] = []

    for run in runs:
        if run["end"] - run["start"] < MIN_WINDOW:
            continue
        start = run["start"]
        while start + MIN_WINDOW <= run["end"] + 0.4:
            end = min(run["end"], start + TARGET_WINDOW)
            if end - start >= MIN_WINDOW:
                a = max(0, int(start / hop))
                b = min(len(voiced), int(end / hop))
                if b - a >= 10:
                    cover = float(voiced[a:b].mean())
                    text = "".join(
                        r["text"] for r in rows
                        if r["end"] > start + 0.2 and r["start"] < end - 0.2
                    )
                    density = len(text) / max(1.0, end - start)
                    if cover >= MIN_COVER and len(text) >= 8 and density >= 1.2:
                        pool.append({
                            "start": round(start, 2),
                            "end": round(end, 2),
                            "seconds": round(end - start, 2),
                            "cover": round(cover, 3),
                            "chars": len(text),
                            "density": round(density, 2),
                            "text": text,
                        })
            start += 2.5

    def score(item):
        dur_fit = 1.0 - abs(item["seconds"] - TARGET_WINDOW) / TARGET_WINDOW
        return item["cover"] * 0.4 + min(item["density"] / 5.0, 1.0) * 0.4 + dur_fit * 0.2

    pool.sort(key=score, reverse=True)

    picked: list[dict] = []
    for item in pool:
        clash = False
        for kept in picked:
            overlap = min(item["end"], kept["end"]) - max(item["start"], kept["start"])
            if overlap > 0.35 * min(item["seconds"], kept["seconds"]):
                clash = True
                break
        if not clash:
            picked.append(item)
        if len(picked) >= limit:
            break
    return picked


def cut_segment(src: Path, start: float, end: float, out: Path, denoise: bool) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    chain = "highpass=f=70"
    if denoise:
        chain += ",afftdn=nr=10:nf=-45"
    chain += ",loudnorm=I=-19:TP=-2:LRA=6"
    cmd = [
        ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(src),
        "-vn", "-ac", "1", "-ar", str(SR), "-af", chain, str(out),
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        die(f"ffmpeg 切片失败：{proc.stderr.decode('utf-8', 'replace')[:300]}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["analyze", "cut", "text"])
    ap.add_argument("--src", required=True)
    ap.add_argument("--start", type=float)
    ap.add_argument("--end", type=float)
    ap.add_argument("--out")
    ap.add_argument("--model", default=os.environ.get("ADD_VOICE_MODEL", DEFAULT_MODEL))
    ap.add_argument("--language", default="zh")
    ap.add_argument("--no-denoise", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    src = Path(args.src).expanduser()
    if not src.is_file():
        die(f"找不到音频：{src}")

    if args.mode == "cut":
        if args.start is None or args.end is None or not args.out:
            die("cut 需要 --start --end --out")
        if args.end <= args.start:
            die("--end 必须大于 --start")
        cut_segment(src, args.start, args.end, Path(args.out).expanduser(), not args.no_denoise)
        size = Path(args.out).expanduser().stat().st_size
        print(json.dumps({"ok": True, "out": str(args.out), "bytes": size,
                          "seconds": round(args.end - args.start, 2)}, ensure_ascii=False))
        return

    with tempfile.TemporaryDirectory(prefix="add-voice-") as tmp:
        wav = Path(tmp) / "src.wav"
        to_wav(src, wav)
        mono, sr, _np = read_mono(wav)

        if args.mode == "text":
            if args.start is None or args.end is None:
                die("text 需要 --start --end")
            clip = Path(tmp) / "clip.wav"
            cut_segment(wav, args.start, args.end, clip, False)
            rows, _dur = transcribe(clip, args.model, args.language)
            print(json.dumps({
                "ok": True,
                "start": args.start,
                "end": args.end,
                "text": "".join(r["text"] for r in rows),
            }, ensure_ascii=False))
            return

        rows, dur = transcribe(wav, args.model, args.language)
        candidates = pick_candidates(mono, sr, rows)
        speech = sum(r["end"] - r["start"] for r in rows)
        print(json.dumps({
            "ok": True,
            "duration": round(len(mono) / sr, 2),
            "reported_duration": round(dur, 2),
            "speech_seconds": round(speech, 2),
            "segments": len(rows),
            "candidates": candidates,
            "transcript": rows[:400],
            "model": args.model,
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()
