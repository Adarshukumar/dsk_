# llmchat model benchmark

`benchmark_models.py` is a reproducible live benchmark for **every model in
`llmchat_provider.py`**. It produces a timestamped JSON report and a readable
Markdown leaderboard under `benchmarks/results/`, so real benchmark runs can
be reviewed and committed to Git history.

## What it measures

Each registered model receives the same three short probes:

1. **Instruction and first-token latency** — must return exactly
   `BENCHMARK_OK`.
2. **Arithmetic reasoning** — must calculate the orange total and finish with
   `ANSWER: 28`.
3. **Structured output** — must return exactly the requested JSON object.

For every probe, the tool records:

- request status (`pass`, `fail`, or `error`),
- time to the first streamed chunk,
- full completion time,
- number of chunks and output characters,
- reasoning-character count when an upstream model emits reasoning,
- both user-visible and raw streamed output (including `<think>` blocks),
- every answer and any error text in the JSON **and** Markdown report.

The Markdown rank prioritises probe correctness/availability before timing.
The *fastest* result is the successful model with the lowest median time to
first chunk. This is deliberately a small technical comparison, not a complete
human evaluation of writing quality or safety.

## Run every model

Use Python 3.10+ and install the project's only runtime dependency:

```bash
cd /path/to/dsk_
./run_model_benchmark.sh --concurrency 1 --timeout 75 --retries 0
```

The launcher creates an isolated `.venv` sandbox and installs the pinned
`curl_cffi` dependency from `requirements.txt` before it starts the benchmark.
You can also use an existing environment with:

```bash
python3 -m pip install -r requirements.txt
python3 benchmark_models.py --concurrency 1 --timeout 75 --retries 0
```

`--concurrency 1` is recommended for a fair latency measurement. It makes
three requests per registered model, one model at a time, and avoids creating
artificial contention between free upstream endpoints.

The command writes files such as:

```text
benchmarks/results/llmchat-20261016T120000Z.json
benchmarks/results/llmchat-20261016T120000Z.md
```

Commit a verified live report if you want to preserve its result history:

```bash
git add benchmarks/results/
git commit -m "Record llmchat model benchmark"
git push origin arena/71d3f44b-dsk
```

## Faster health check

This runs all models concurrently. It is faster, but its timing values are not
comparable to the sequential run because the upstream service is shared.

```bash
python3 benchmark_models.py --concurrency 4 --timeout 75 --retries 0
```

## Test selected models

A comma-separated list accepts exact model IDs or unique substrings:

```bash
python3 benchmark_models.py \
  --models llama-3.3-70b,glm-4.7-flash,qwen3-30b \
  --concurrency 1
```

## Interpret a result

- `pass` means the output satisfied that probe's expected answer/format.
- `fail` means a model responded but did not satisfy the requested output.
- `error` means the request/stream failed or timed out.
- The final response text is saved in JSON. The Markdown report keeps the
  leaderboard and per-probe status compact.
- Run the sequential command more than once on different times/days before
  treating small latency differences as meaningful.
