# frc-schedule-builder

A single-page web app that helps you visualise and analyse an FRC event's qualification-match schedule.

## What it does

1. **Enter an event key** (e.g. `2024miket`).
2. The app loads the **number of registered teams** from [The Blue Alliance](https://www.thebluealliance.com) API.
3. It follows the redirect at `thebluealliance.com/event/<key>/agenda`, detects the linked PDF agenda, and **surfaces a link so you can look up how many minutes are allocated to qualification matches**.
4. You enter the **matches per team** and **match cycle time** (minutes per match including setup/reset).
5. The app calculates:
   - Total number of qualification matches (3 v 3 — 6 team slots per match)
   - Any **surrogate** plays required to round the slot count to a multiple of 6
   - Total time needed vs. time available
   - Whether the schedule **fits**, and by how much

## Usage

Open `index.html` in any modern browser — no build step or server required.

```bash
# Quick start using Python's built-in server (avoids browser CORS quirks)
python3 -m http.server 8080
# then open http://localhost:8080
```

## Development

The project is pure vanilla HTML/CSS/ES-module JavaScript — no dependencies or build tools.

```
index.html      – SPA entry point
src/
  app.js        – application logic (exported functions are unit-testable)
  style.css     – styles
```

### Running tests

```bash
node --experimental-vm-modules node_modules/.bin/jest
```

(or simply `npm test` if a `package.json` with jest is present)

