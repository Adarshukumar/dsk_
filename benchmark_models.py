#!/usr/bin/env python3
"""Benchmark every llmchat.in model registered by llmchat_provider.py.

This is a reproducible *live* benchmark, not a hard-coded leaderboard. It
measures availability, time to first streamed chunk, completion time, output
size, optional reasoning output, instruction following, simple arithmetic, and
strict JSON output. Results are written as both JSON and Markdown so a run can
be kept in Git history.

Examples:
    python benchmark_models.py
    python benchmark_models.py --concurrency 1 --timeout 75
    python benchmark_models.py --models llama-3.3,glm-4.7 --no-write

Run the complete suite sequentially when comparing model latency. Concurrent
runs are useful for a quick health check but share upstream capacity and can
make latency figures less comparable.
"""
from __future__ import annotations

import argparse
import ast
import asyncio
import json
import re
import statistics
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence


# The probes are deliberately short so testing all registered free models is
# practical. They test three different failure modes: first-token latency,
# basic reasoning/correctness, and strict output formatting.
@dataclass(frozen=True)
class Probe:
    key: str
    label: str
    prompt: str
    max_tokens: int
    scorer: Callable[[str], tuple[bool, str]]


def _normalise(text: str) -> str:
    return " ".join(text.strip().split())


def _score_exact_ok(text: str) -> tuple[bool, str]:
    actual = _normalise(text).strip("` .")
    ok = actual == "BENCHMARK_OK"
    return ok, "exact BENCHMARK_OK" if ok else f"expected only BENCHMARK_OK; got {actual[:120]!r}"


def _score_arithmetic(text: str) -> tuple[bool, str]:
    # Permit a short explanation, but require the requested final answer.
    ok = bool(re.search(r"ANSWER\s*:\s*28\b", text, flags=re.I))
    return ok, "contains ANSWER: 28" if ok else "missing required final answer ANSWER: 28"


def _decode_json_object(text: str) -> dict[str, Any] | None:
    """Find the first JSON object even if a model accidentally adds fencing."""
    candidate = text.strip()
    candidate = re.sub(r"^```(?:json)?\s*", "", candidate, flags=re.I)
    candidate = re.sub(r"\s*```$", "", candidate)
    starts = [i for i, char in enumerate(candidate) if char == "{"]
    decoder = json.JSONDecoder()
    for start in starts:
        try:
            value, _ = decoder.raw_decode(candidate[start:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def _score_json(text: str) -> tuple[bool, str]:
    value = _decode_json_object(text)
    ok = value == {"sum": 17, "status": "ok"}
    return ok, "valid requested JSON" if ok else f"expected {{'sum': 17, 'status': 'ok'}}; got {value!r}"


def _score_pen_reasoning(text: str) -> tuple[bool, str]:
    # The familiar Rs.110 / Rs.100-difference problem catches shallow "Rs.10"
    # pattern matching. A correct answer is Rs.5.
    ok = bool(re.search(r"ANSWER\s*:\s*(?:Rs\.?\s*)?5(?:\.0+)?\b", text, flags=re.I))
    return ok, "contains ANSWER: Rs.5" if ok else "missing required final answer ANSWER: Rs.5"


def _extract_python_source(text: str) -> str:
    fenced = re.search(r"```(?:python)?\s*(.*?)```", text, flags=re.S | re.I)
    if fenced:
        return fenced.group(1).strip()
    start = text.find("def clamp")
    return text[start:].strip() if start >= 0 else text.strip()


def _score_python_syntax(text: str) -> tuple[bool, str]:
    """Safely inspect model-generated Python without executing untrusted code."""
    source = _extract_python_source(text)
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return False, f"invalid Python syntax: {exc.msg}"
    function = next((node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "clamp"), None)
    if function is None:
        return False, "no clamp(value, lower, upper) function found"
    args = [arg.arg for arg in function.args.args]
    if args != ["value", "lower", "upper"]:
        return False, f"clamp arguments were {args!r}"
    if not any(isinstance(node, ast.Return) for node in ast.walk(function)):
        return False, "clamp has no return statement"
    return True, "valid Python with clamp(value, lower, upper); not executed for safety"


def _score_hinglish(text: str) -> tuple[bool, str]:
    words = re.findall(r"[\w']+", text, flags=re.UNICODE)
    has_hindi_marker = bool(re.search(r"\b(aap|aapka|hai|ka|ki|kar|raha|rahi|bilkul)\b", text, flags=re.I))
    ok = 4 <= len(words) <= 18 and has_hindi_marker and not re.search(r"\b(price|pricing)\b", text, flags=re.I)
    if ok:
        return True, "short Hinglish response with a Hindi marker"
    return False, "expected 4–18 words, a Hinglish marker, and no pricing claim"


def _score_fact_extraction(text: str) -> tuple[bool, str]:
    compact = re.sub(r"\s+", "", text).lower()
    expected = "name=riya;city=jaipur;need=portfoliowebsite"
    ok = compact == expected
    return ok, "exact extracted facts" if ok else f"expected {expected!r}"


CORE_PROBES: tuple[Probe, ...] = (
    Probe(
        key="latency",
        label="Instruction / first-token latency",
        prompt="Reply with exactly this single token and nothing else: BENCHMARK_OK",
        max_tokens=32,
        scorer=_score_exact_ok,
    ),
    Probe(
        key="reasoning",
        label="Arithmetic reasoning",
        prompt=(
            "A shop has three boxes with 12, 15, and 9 oranges. It sells 8 oranges. "
            "Work it out briefly, then make your final line exactly: ANSWER: 28"
        ),
        max_tokens=128,
        scorer=_score_arithmetic,
    ),
    Probe(
        key="json",
        label="Structured-output following",
        prompt=(
            "Return only valid JSON, with no Markdown or explanation. "
            "The complete object must be: {\"sum\":17,\"status\":\"ok\"}"
        ),
        max_tokens=64,
        scorer=_score_json,
    ),
)

# The default capability suite adds questions that exercise deeper reasoning,
# source-code construction, Hinglish tone, and exact fact extraction. Answers
# are retained in the report for manual review; automatic scores are useful
# indicators, not a substitute for reading the model outputs.
CAPABILITY_PROBES: tuple[Probe, ...] = CORE_PROBES + (
    Probe(
        key="logic",
        label="Reasoning trap / algebra",
        prompt=(
            "A notebook and a pen cost Rs.110 together. The notebook costs Rs.100 more than "
            "the pen. Work it out briefly, then make your final line exactly: ANSWER: Rs.5"
        ),
        max_tokens=128,
        scorer=_score_pen_reasoning,
    ),
    Probe(
        key="python",
        label="Python code construction",
        prompt=(
            "Return only valid Python source code, with no Markdown. Define exactly "
            "def clamp(value, lower, upper): which returns lower when value is below lower, "
            "upper when value is above upper, and value otherwise."
        ),
        max_tokens=160,
        scorer=_score_python_syntax,
    ),
    Probe(
        key="hinglish",
        label="Short Hinglish client reply",
        prompt=(
            "Reply to a client in one friendly Hinglish sentence of 4 to 18 words: their "
            "website demo is ready. Do not mention any price, do not use Markdown, and do not use quotes."
        ),
        max_tokens=64,
        scorer=_score_hinglish,
    ),
    Probe(
        key="extraction",
        label="Precise fact extraction",
        prompt=(
            "Read these facts: Riya lives in Jaipur and wants a portfolio website; she does not "
            "want a mobile app. Return exactly this one line and nothing else: "
            "name=Riya; city=Jaipur; need=portfolio website"
        ),
        max_tokens=64,
        scorer=_score_fact_extraction,
    ),
)

SUITES: dict[str, tuple[Probe, ...]] = {
    "core": CORE_PROBES,
    "capability": CAPABILITY_PROBES,
}

_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.S | re.I)
_THINK_OPEN = re.compile(r"<think>.*$", re.S | re.I)


def strip_thinking(text: str) -> str:
    """Keep the user-visible answer while retaining raw output in the result."""
    return _THINK_OPEN.sub("", _THINK_BLOCK.sub("", text)).strip()


def seconds(value: float | None) -> str:
    return "—" if value is None else f"{value:.2f}s"


def median_or_none(values: Sequence[float]) -> float | None:
    return round(statistics.median(values), 4) if values else None


@dataclass
class ProbeResult:
    key: str
    label: str
    status: str
    passed: bool
    score_detail: str
    first_chunk_s: float | None
    elapsed_s: float
    chunks: int
    raw_chars: int
    visible_chars: int
    reasoning_chars: int
    # `response` is the user-visible answer with <think> blocks removed;
    # `raw_response` preserves every streamed token for the audit report.
    response: str
    raw_response: str
    error: str | None = None


async def run_probe(
    provider_class: type,
    model_name: str,
    probe: Probe,
    *,
    timeout: int,
    retries: int,
) -> ProbeResult:
    """Run one streamed probe and collect latency without printing model text."""
    started = time.perf_counter()
    first_chunk_s: float | None = None
    chunks: list[str] = []
    error: str | None = None

    try:
        provider = provider_class(
            model=model_name,
            system="Follow the user's instruction exactly.",
            temperature=0.0,
            max_tokens=probe.max_tokens,
            timeout=timeout,
            retries=retries,
        )
        async for chunk in provider.chat(data=probe.prompt):
            if first_chunk_s is None:
                first_chunk_s = time.perf_counter() - started
            chunks.append(chunk)
    except Exception as exc:  # Individual models are expected to sometimes fail.
        error = f"{type(exc).__name__}: {exc}"

    elapsed = time.perf_counter() - started
    raw = "".join(chunks)
    visible = strip_thinking(raw)
    reasoning_parts = _THINK_BLOCK.findall(raw)
    reasoning_chars = sum(len(part) for part in reasoning_parts)

    if error:
        return ProbeResult(
            key=probe.key,
            label=probe.label,
            status="error",
            passed=False,
            score_detail="request failed",
            first_chunk_s=first_chunk_s,
            elapsed_s=round(elapsed, 4),
            chunks=len(chunks),
            raw_chars=len(raw),
            visible_chars=len(visible),
            reasoning_chars=reasoning_chars,
            response=visible,
            raw_response=raw,
            error=error,
        )

    passed, detail = probe.scorer(visible)
    return ProbeResult(
        key=probe.key,
        label=probe.label,
        status="pass" if passed else "fail",
        passed=passed,
        score_detail=detail,
        first_chunk_s=round(first_chunk_s, 4) if first_chunk_s is not None else None,
        elapsed_s=round(elapsed, 4),
        chunks=len(chunks),
        raw_chars=len(raw),
        visible_chars=len(visible),
        reasoning_chars=reasoning_chars,
        response=visible,
        raw_response=raw,
        error=None,
    )


async def benchmark_model(
    provider_class: type,
    model: Any,
    *,
    probes: Sequence[Probe],
    timeout: int,
    retries: int,
) -> dict[str, Any]:
    results: list[ProbeResult] = []
    for probe in probes:
        result = await run_probe(
            provider_class,
            model.name,
            probe,
            timeout=timeout,
            retries=retries,
        )
        results.append(result)
        marker = "✓" if result.passed else "!"
        print(
            f"  {marker} {model.name:<52.52} {probe.key:<9} "
            f"first={seconds(result.first_chunk_s):>7} total={seconds(result.elapsed_s):>7} "
            f"{result.status}",
            flush=True,
        )

    first_chunks = [r.first_chunk_s for r in results if r.first_chunk_s is not None]
    completions = [r.elapsed_s for r in results if r.status != "error"]
    passed = sum(r.passed for r in results)
    response_count = sum(r.status != "error" for r in results)
    return {
        "model": model.name,
        "provider_tag": model.tag,
        "advertised_max_tokens": model.max_tokens,
        "probes": [asdict(result) for result in results],
        "summary": {
            "passed": passed,
            "probe_count": len(probes),
            "responses_received": response_count,
            "median_first_chunk_s": median_or_none(first_chunks),
            "median_completion_s": median_or_none(completions),
            "total_reasoning_chars": sum(r.reasoning_chars for r in results),
        },
    }


def choose_models(all_models: Sequence[Any], selector: str | None) -> list[Any]:
    if not selector:
        return list(all_models)
    wanted = [part.strip().lower() for part in selector.split(",") if part.strip()]
    selected: list[Any] = []
    unmatched: list[str] = []
    for query in wanted:
        match = next((model for model in all_models if model.name.lower() == query), None)
        if match is None:
            match = next((model for model in all_models if query in model.name.lower()), None)
        if match is None:
            unmatched.append(query)
        elif match not in selected:
            selected.append(match)
    if unmatched:
        available = ", ".join(model.name for model in all_models)
        raise ValueError(f"No model matches: {', '.join(unmatched)}\nAvailable: {available}")
    return selected


def rank_models(results: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    # Quality/compliance comes first; speed breaks ties. This prevents a model
    # that immediately returns a wrong answer from being called "best".
    def key(item: dict[str, Any]) -> tuple[float, float, float, float, str]:
        summary = item["summary"]
        first = summary["median_first_chunk_s"]
        completion = summary["median_completion_s"]
        return (-summary["passed"], -(summary["responses_received"]), first if first is not None else float("inf"),
                completion if completion is not None else float("inf"), item["model"])

    return sorted(results, key=key)


def markdown_report(payload: dict[str, Any]) -> str:
    rows = rank_models(payload["models"])
    lines = [
        "# llmchat model benchmark",
        "",
        f"- Started (UTC): `{payload['started_at_utc']}`",
        f"- Finished (UTC): `{payload['finished_at_utc']}`",
        f"- Models tested: **{len(rows)}**",
        f"- Suite: **{payload['settings'].get('suite', 'unspecified')}**",
        f"- Per-model timeout: **{payload['settings']['timeout_s']} s**",
        f"- Retries per request: **{payload['settings']['retries']}**",
        f"- Concurrency: **{payload['settings']['concurrency']}**",
        "",
        "This is a small reproducible health/latency/compliance benchmark, not a complete human quality evaluation. "
        "The `Best` rank prioritises successful probe scores and then latency.",
        "",
        "| Rank | Model | Passed | Responses | Median first chunk | Median completion | Reasoning chars |",
        "| ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for rank, item in enumerate(rows, start=1):
        summary = item["summary"]
        lines.append(
            f"| {rank} | `{item['model']}` | {summary['passed']}/{summary['probe_count']} | "
            f"{summary['responses_received']}/{summary['probe_count']} | "
            f"{seconds(summary['median_first_chunk_s'])} | {seconds(summary['median_completion_s'])} | "
            f"{summary['total_reasoning_chars']} |"
        )

    lines.extend(["", "## Per-probe outcomes", ""])
    for item in rows:
        lines.append(f"### `{item['model']}`")
        lines.append("")
        lines.append("| Probe | Status | First chunk | Completion | Detail |")
        lines.append("| --- | --- | ---: | ---: | --- |")
        for probe in item["probes"]:
            detail = probe["error"] or probe["score_detail"]
            detail = detail.replace("|", "\\|").replace("\n", " ")[:240]
            lines.append(
                f"| {probe['key']} | {probe['status']} | {seconds(probe['first_chunk_s'])} | "
                f"{seconds(probe['elapsed_s'])} | {detail} |"
            )
        lines.append("")

    # Keep every actual answer in the human-readable report as well as JSON.
    # Raw output includes <think> blocks whenever the upstream provider emitted
    # them, which makes the result auditable instead of hiding reasoning data.
    lines.extend(["## Captured streamed answers", ""])
    for item in rows:
        lines.append(f"### `{item['model']}`")
        lines.append("")
        for probe in item["probes"]:
            lines.append(
                f"#### {probe['key']} — {probe.get('label', probe['key'])} — {probe['status']} "
                f"(first chunk {seconds(probe['first_chunk_s'])}; total {seconds(probe['elapsed_s'])})"
            )
            answer = probe.get("raw_response") or probe.get("response") or "(no streamed output)"
            if probe.get("error"):
                answer += f"\n\nERROR: {probe['error']}"
            lines.extend("    " + line for line in answer.splitlines() or ["(empty output)"])
            lines.append("")
    return "\n".join(lines) + "\n"


def default_output_paths() -> tuple[Path, Path]:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    root = Path("benchmarks") / "results"
    return root / f"llmchat-{stamp}.json", root / f"llmchat-{stamp}.md"


async def async_main(args: argparse.Namespace) -> int:
    try:
        # Delayed import keeps --help usable before curl_cffi is installed.
        from llmchat_provider import LLMChatProvider, MODELS
    except ImportError as exc:
        print(
            "Cannot load llmchat_provider. Install the documented dependency first:\n"
            "  python -m pip install curl_cffi\n\n"
            f"Import error: {exc}",
            file=sys.stderr,
        )
        return 2

    try:
        selected = choose_models(MODELS, args.models)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    probes = SUITES[args.suite]
    print(
        f"Benchmarking {len(selected)} model(s), {len(probes)} {args.suite} probe(s) each; "
        f"concurrency={args.concurrency}, timeout={args.timeout}s, retries={args.retries}",
        flush=True,
    )
    started = datetime.now(timezone.utc)
    semaphore = asyncio.Semaphore(args.concurrency)

    async def guarded(model: Any) -> dict[str, Any]:
        async with semaphore:
            return await benchmark_model(
                LLMChatProvider, model, probes=probes, timeout=args.timeout, retries=args.retries
            )

    # as_completed prints live progress while preserving a complete JSON report.
    tasks = [asyncio.create_task(guarded(model)) for model in selected]
    results: list[dict[str, Any]] = []
    for task in asyncio.as_completed(tasks):
        results.append(await task)

    finished = datetime.now(timezone.utc)
    payload = {
        "started_at_utc": started.isoformat(),
        "finished_at_utc": finished.isoformat(),
        "settings": {
            "suite": args.suite,
            "timeout_s": args.timeout,
            "retries": args.retries,
            "concurrency": args.concurrency,
            "probe_keys": [probe.key for probe in probes],
        },
        "models": results,
    }
    ranked = rank_models(results)
    complete = [item for item in ranked if item["summary"]["passed"] == len(probes)]
    fastest = min(
        complete or [item for item in ranked if item["summary"]["responses_received"]],
        key=lambda item: item["summary"]["median_first_chunk_s"] or float("inf"),
        default=None,
    )

    print("\n=== Summary ===")
    if ranked:
        best = ranked[0]
        print(f"Best probe score: {best['model']} ({best['summary']['passed']}/{len(probes)})")
    if fastest:
        print(
            f"Fastest first chunk: {fastest['model']} "
            f"({seconds(fastest['summary']['median_first_chunk_s'])})"
        )
    else:
        print("No model returned a response.")

    if not args.no_write:
        json_path = Path(args.json_out) if args.json_out else default_output_paths()[0]
        markdown_path = Path(args.markdown_out) if args.markdown_out else json_path.with_suffix(".md")
        json_path.parent.mkdir(parents=True, exist_ok=True)
        markdown_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        markdown_path.write_text(markdown_report(payload), encoding="utf-8")
        print(f"JSON report: {json_path}")
        print(f"Markdown report: {markdown_path}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Live benchmark of every registered llmchat.in model")
    parser.add_argument(
        "--models",
        help="comma-separated exact names or unique substrings; default tests every registered model",
    )
    parser.add_argument(
        "--suite",
        choices=sorted(SUITES),
        default="capability",
        help="question set to run: capability=7 varied probes, core=3 quick probes (default: capability)",
    )
    parser.add_argument("--timeout", type=int, default=75, help="per-request timeout in seconds (default: 75)")
    parser.add_argument("--retries", type=int, default=0, help="provider retries per probe (default: 0)")
    parser.add_argument(
        "--concurrency",
        type=int,
        default=1,
        help="models to test simultaneously; 1 gives fairest latency measurements (default: 1)",
    )
    parser.add_argument("--json-out", help="path for the JSON result report")
    parser.add_argument("--markdown-out", help="path for the Markdown result report")
    parser.add_argument("--no-write", action="store_true", help="print a summary without creating report files")
    args = parser.parse_args()
    if args.timeout <= 0 or args.retries < 0 or args.concurrency <= 0:
        parser.error("--timeout and --concurrency must be positive; --retries cannot be negative")
    return args


def main() -> int:
    return asyncio.run(async_main(parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
