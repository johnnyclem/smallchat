# Weather Agent Example

An agent that uses smallchat to dispatch weather-related intents like
"get current weather", "forecast for this week", and "weather alerts".

## Setup

```bash
cd examples/weather-agent
npm install
export WEATHER_API_KEY=your_key_here
npm start
```

## Tools

- **get_current_weather** — Get current weather conditions for a location
- **get_forecast** — Get a multi-day weather forecast
- **get_alerts** — Get active weather alerts for a region
- **search_location** — Search for a location by name

## How It Works

This example demonstrates streaming dispatch: weather data is returned
progressively using `dispatchStream()`, showing real-time resolution feedback.
