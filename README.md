# GleeFull QA Dashboard

A local QA dashboard for saving Preview/Live URL pairs and running combined functional and visual regression checks. It uses Playwright and Chromium with `pixelmatch` and `pngjs` for image diffs. No paid service or AI is required.

## Requirements

- Node.js 20 or newer and npm.
- Chromium dependencies supported by Playwright. On Linux, the browser install command below installs the browser; if system libraries are missing, run `npx playwright install-deps chromium` from a machine where you can install OS packages.
- Approximately 250 MB for Chromium and FFmpeg. Runs use one browser process, usually 100-500 MB RAM depending on the pages. Screenshot storage varies with page length and run count.

## Start on Linux

```sh
cd /home/ads/Documents/gleefull
npm install
npx playwright install chromium
npm start
```

Open <http://127.0.0.1:4173>. The server binds only to loopback. Stop it with Ctrl+C. The dashboard writes configuration to `data/config.json`, run summaries to `data/history.json`, and detailed reports/screenshots under `data/runs/`. These are ignored by git and remain on this computer. Optional settings are shown in `.env.example`; the server reads environment variables but does not automatically load `.env`.

## Configure URL pairs

Each row represents one page: enter its Preview Link (DEV) and matching Live Link (PROD). Use the exact full URL for each side; the paths can differ. Changes save automatically and remain available after you close or restart the dashboard. Add rows with **+ Add Page** and remove them with the row delete button. The dashboard supports up to 100 pairs.

Both URLs must be complete `http://` or `https://` URLs without embedded credentials. The `data/pairs.json` file stores the pair list. Existing page configurations are left intact; the dashboard imports their current Preview/Live URLs into the new pair list once, if no pair list exists.

## Run tests

1. Make sure every row has a valid Preview and Live URL.
2. Select **Run Regression Tests**. All pairs run in Full mode on desktop and mobile; each page failure is recorded without stopping other pairs.
3. The runner checks page load/status, main content, title/H1 differences, internal destinations, named links/buttons, native required-field validation (without submitting forms), broken images, JavaScript/first-party server errors, horizontal overflow, and DOM-ready time.
4. It captures Preview and Live viewport/full-page screenshots, computes pixel diffs, and lists each issue with its page, URL, expected/observed result, next step, and evidence. A missing/unavailable Live URL becomes a visible issue.
5. Open the detailed HTML report from the dashboard for the full checks and evidence. The last runs remain in local history.

Visual differences are potential regressions, not automatically confirmed defects; Live content can change independently. Full-page comparisons use the same viewport, browser, device scale factor, light color scheme, and reduced motion. Forms are checked without submitting them. The runner only activates buttons with `aria-expanded` to verify safe disclosure/menu behavior; it does not blindly click other buttons or submit forms.

## Controlled demonstration

The local regression tests use an in-process fixture with a deliberate style and content difference, an unavailable reference, and a mismatched task expectation. These tests verify diff and issue reporting without contacting the real storefront.

## Automated tests and reports

```sh
npm test
npm run qa
npm run qa:report
```

- `npm test` validates configuration/safety rules, persistent URL pairs, and the browser runner against a local fixture. It deliberately verifies visual, content, reference-availability, and task issues.
- `npm run qa` runs Playwright smoke tests against the local dashboard using a fresh temporary data directory; it verifies multirow persistence, URL validation, and the pair-based regression workflow. It does not test the live store.
- `npm run qa:report` opens Playwright's HTML smoke-test report after `npm run qa`.
- Each dashboard run creates `report.json`, `report.html`, full-page/viewport screenshots, and pixel-diff PNGs inside its run directory.

## Safety, privacy, and limits

- Only configure sites you own or have permission to test. Regression reads both pages and checks internal links; it does not submit forms, place orders, or perform purchases. Screenshots may contain page content, so keep local files private.
- The app has no authentication because it binds to `127.0.0.1`; do not expose the port publicly or change the bind host without adding authentication and CSRF protections.
- Up to 40 unique same-origin links per page are checked. 404 and first-party 5xx responses are reported; other 4xx responses are not automatically classified as defects.
- Pixel diffs can flag legitimate Live content changes, personalization, cookie banners, and third-party rendering differences. Review issue evidence before treating a difference as a bug.
- Runs use one Chromium process and compare desktop and mobile; reduce the number of pairs to shorten run time.

## Troubleshooting

- Browser launch error: run `npx playwright install chromium`. If Linux reports missing shared libraries, run `npx playwright install-deps chromium` where OS package installation is allowed.
- Preview unavailable or timed out: open the exact saved URL in a browser, confirm VPN/access/deployment state, and check that it does not require an unconfigured login. This runner does not store credentials.
- False visual regression: inspect the live and target viewport/full-page images, confirm both pages show comparable consent/content states, and review dynamic Live content before treating the diff as a defect.
- Run stuck: cancel from the dashboard. Browser navigation and locator checks have bounded timeouts; an in-flight navigation may take until its navigation timeout to stop.
- Data reset: stop the server and remove the local `data/` folder only if you intend to delete all local configuration, history, screenshots, and baselines.

See [TEST-CASES.md](TEST-CASES.md) for the daily release checklist and storefront journey matrix.
