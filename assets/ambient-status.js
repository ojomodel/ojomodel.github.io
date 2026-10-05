(() => {
  "use strict";
  const widget = document.querySelector("[data-ambient-status]");
  if (!widget) return;
  const clock = widget.querySelector("time");
  const zone = widget.querySelector("[data-clock-zone]");
  const weather = widget.querySelector("[data-weather-link]");
  const temperature = widget.querySelector("[data-weather-temperature]");
  const condition = widget.querySelector("[data-weather-condition]");
  const icon = widget.querySelector("[data-weather-icon]");
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hour: "numeric", minute: "2-digit",
    hour12: true, timeZoneName: "short"
  });
  function updateClock() {
    const now = new Date();
    const parts = Object.fromEntries(formatter.formatToParts(now).map(({type, value}) => [type, value]));
    clock.textContent = `${parts.hour}:${parts.minute}${parts.dayPeriod.toLowerCase()}`;
    clock.dateTime = now.toISOString();
    zone.textContent = parts.timeZoneName;
    clock.setAttribute("aria-label", `${parts.hour}:${parts.minute} ${parts.dayPeriod} Central Time in Houston, Texas`);
  }

  const icons = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20.5 14.1A8.8 8.8 0 0 1 9.9 3.5a9 9 0 1 0 10.6 10.6Z"/>',
    cloud: '<path d="M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 8.5 4.8 4.8 0 0 1 18 18Z"/>',
    partly: '<path d="M8 2v2M2 8h2m-.2-4.2 1.4 1.4M12.8 3.8l-1.4 1.4M5.2 11.4a4 4 0 1 1 6.2-6.2"/><path d="M8 20a3.5 3.5 0 1 1 0-7 5 5 0 0 1 9.7-1.5A4.3 4.3 0 1 1 18 20Z"/>',
    rain: '<path d="M6 14a3 3 0 0 1-.4-6A5 5 0 0 1 15 6.5 4 4 0 1 1 3 7.5M8 17l-1 3m6-3-1 3m6-3-1 3"/>',
    snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9 5l3 3 3-3M9 19l3-3 3 3"/>',
    fog: '<path d="M5 9a3 3 0 0 1 1.5-5.6A5 5 0 0 1 16 5a3.5 3.5 0 0 1 3 4M3 13h18M5 17h14M8 21h8"/>',
    storm: '<path d="M6 14a3 3 0 0 1-.4-6A5 5 0 0 1 15 6.5 4 4 0 1 1 3 7.5M12 13l-3 5h5l-3 5"/>'
  };
  function describe(code, day) {
    if (code === 0 || code === 1) return [code === 0 ? "Clear" : "Mostly clear", day ? "sun" : "moon"];
    if (code === 2) return ["Partly cloudy", day ? "partly" : "cloud"];
    if (code === 3) return ["Overcast", "cloud"];
    if ([45,48].includes(code)) return ["Fog", "fog"];
    if ([51,53,55].includes(code)) return ["Drizzle", "rain"];
    if ([56,57,66,67].includes(code)) return ["Freezing rain", "rain"];
    if ([61,63,65,80,81,82].includes(code)) return ["Rain", "rain"];
    if ([71,73,75,77,85,86].includes(code)) return ["Snow", "snow"];
    if ([95,96,97,99].includes(code)) return ["Thunderstorms", "storm"];
    return ["Weather", "cloud"];
  }
  const refreshInterval = 60 * 1000;
  let fetching = false;
  function renderWeather(current) {
    if (!Number.isFinite(current?.temperature_2m) || !Number.isInteger(current?.weather_code) || !Number.isFinite(current?.time)) throw new Error("Weather data unavailable");
    // Open-Meteo current conditions use 15-minute model steps. Reject old data.
    const age = Date.now() - current.time * 1000;
    if (age > 30 * 60 * 1000 || age < -5 * 60 * 1000) throw new Error("Weather data is stale");
    const [label, symbol] = describe(current.weather_code, current.is_day === 1);
    const reading = `${Math.round(current.temperature_2m)}°F`;
    temperature.textContent = reading;
    condition.textContent = label;
    icon.innerHTML = icons[symbol];
    const observed = formatter.format(new Date(current.time * 1000));
    weather.title = `Houston weather · ${reading}, ${label.toLowerCase()} · Reading: ${observed} · Data by Open-Meteo`;
    weather.setAttribute("aria-label", weather.title);
    widget.dataset.weatherState = "ready";
  }
  async function updateWeather() {
    if (fetching) return;
    fetching = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      // Fixed city-level weather; no visitor location or API key is requested.
      const response = await fetch("https://api.open-meteo.com/v1/forecast?latitude=29.76&longitude=-95.37&current=temperature_2m,weather_code,is_day&temperature_unit=fahrenheit&timeformat=unixtime", { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error("Weather service unavailable");
      const data = await response.json();
      renderWeather(data.current);
    } catch {
      temperature.textContent = "";
      condition.textContent = "Weather unavailable";
      icon.innerHTML = icons.cloud;
      widget.dataset.weatherState = "unavailable";
      weather.title = "Houston weather unavailable · Open-Meteo";
      weather.setAttribute("aria-label", weather.title);
    } finally {
      clearTimeout(timeout);
      fetching = false;
    }
  }
  updateClock();
  updateWeather();
  setInterval(() => { if (!document.hidden) updateClock(); }, 1000);
  setInterval(() => { if (!document.hidden) updateWeather(); }, refreshInterval);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { updateClock(); updateWeather(); }
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) { updateClock(); updateWeather(); }
  });
  window.addEventListener("online", () => { if (!document.hidden) updateWeather(); });
})();
