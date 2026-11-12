# Reproducible environment for kaggle-measurement: install from the lockfile, typecheck, and run the
# whole test suite (unit + integration) at BUILD time, so an image only exists if everything is green.
#   docker build -t kaggle-measurement .
#   docker run --rm kaggle-measurement                       # re-run the suite
#   docker run --rm kaggle-measurement bun competitions/gemma4-swe-agent/scripts/reproduce-paper-numbers.ts
#   docker run --rm --network host -e LIVE_UPSTREAM=http://127.0.0.1:8010 kaggle-measurement bun test test/integration
FROM oven/bun:1.3.13
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bunx tsc --noEmit -p . && bun test
USER bun
CMD ["bun", "test"]
