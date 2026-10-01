# Weather Agent Example

An agent that uses smallchat to dispatch weather-related intents like
"get current weather", "forecast for this week", and "weather alerts".

## Run

From the repository root (Node 22+):

```bash
npm install && npm run build
node --experimental-strip-types examples/weather-agent/index.ts   # Node 24: plain `node`
```

The tools are compiled from `manifest.json` in-process with the default
(ONNX) embedder, as `smallchat serve --source examples/weather-agent` would.

## Tools

- **get_current_weather** — Get current weather conditions for a location
- **get_forecast** — Get a multi-day weather forecast
- **get_alerts** — Get active weather alerts for a region
- **search_location** — Search for a location by name

## How It Works

The tools are `local` stand-ins registered in `index.ts`; replace them with
calls to a weather API.

This example demonstrates streaming dispatch with `dispatchStream()`:
`resolving`, then `tool-start` naming the tool id and confidence, then the
tool's output as `chunk`s and `done`. An intent that does not resolve to one
tool (here a MEDIUM match with no LLM verifier, and an intent nothing
matches) goes straight to `done` with an `isError` result carrying the
outcome; nothing runs.
