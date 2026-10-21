# GleeFull QA Dashboard

A local, reusable QA workspace for comparing configured live/reference pages with Preview or Production. It uses Playwright and Chromium for browser checks, `pixelmatch` + `pngjs` for screenshot diffs, and `@axe-core/playwright` for optional automated accessibility scans. There is no paid service or AI requirement.

## Requirements

- Node.js 20 or newer and npm.
- Chromium dependencies supported by Playwright. On Linux, the browser install command below installs the browser; if system libraries are missing, run `npx playwright install-deps chromium` from a machine where you can install OS packages.
- Approximately 250 MB for Chromium and FFmpeg. Runs use one browser process, usually 100-500 MB RAM depending on the pages. Screenshot storage varies with page length and run count; keep the history retention low for smaller projects.

## Start on Linux

```sh
cd /home/ads/Documents/gleefull
npm install
npx playwright install chromium
npm start
```

Open <http://127.0.0.1:4173>. The server binds only to loopback. Stop it with Ctrl+C. The dashboard writes configuration to `data/config.json`, run summaries to `data/history.json`, and detailed reports/screenshots under `data/runs/`. These are ignored by git and remain on this computer. Optional settings are shown in `.env.example`; the server reads environment variables but does not automatically load `.env`.

## Configure pages

1. Add a page and enter its name plus its exact Live/reference, Preview, and Production URLs. These full URLs are stored separately. Different routes or domains across environments are supported; no URL is inferred from another.
2. Add its Figma frame/prototype URL for the manual design review, and optionally enter expected page-title/H1 text and CSS selectors for content that changes dynamically.
3. Save. Configuration survives a server restart. Enable or disable pages in the editor; select rows to run a subset. With no rows selected, the runner uses all enabled pages.
4. Save Live/Preview/Production base URLs in settings to prefill new page records. They do not alter saved page URLs.
5. Use JSON or CSV export/import to back up or reuse the page list. Import replaces the saved page list after confirmation; task specs for removed pages are removed too.

The Live/reference base field is prefilled with the `https://gleefullsupps.com` URL supplied for this workspace. No page routes, Preview URL, or Production URL are preconfigured.

CSV uses the headers `id,name,enabled,liveUrl,previewUrl,productionUrl,figmaUrl,expectedTitle,expectedHeading,ignoreSelectors`. Dynamic selectors in `ignoreSelectors` are separated with `|`. JSON accepts either the full configuration object or a `pages` array.

## Run tests

1. Select Preview or Production, a mode, viewports, and pages.
2. Confirm that you own or are authorized to test the configured URLs.
3. Select **Start test run**. Runs are sequential to limit resource use. A page timeout or failure is recorded and does not prevent remaining pages from running.
4. The full mode checks page availability, main content, expected title/H1 (when configured), Live/target title-and-H1 differences, internal destinations, interactive control names, image loading, runtime errors, horizontal overflow, and screenshots against the configured live/reference URL. A missing or unavailable Live reference is a visible failed UI check, not a silent skip.
5. UI-only runs page/layout/media and screenshot checks. Functional-only omits pixel comparison. Specific-task runs require a saved task spec marked approved and run only on Preview.
6. The dashboard shows issues, expected/actual details, reproduction steps, screenshots and diff links, and a standalone HTML report. Download JSON or CSV issues. Issues can be marked reviewed/resolved; history is kept locally according to the retention setting.

The visual comparison captures both full-page and viewport screenshots at 1440 x 1000 and/or 390 x 844, with device scale factor 1, light color scheme, reduced motion, loaded fonts/images, and optional CSS masks. Pixel differences over the configured percentage or differing image dimensions are **potential** regressions, not confirmed defects. Compare changed pages with the configured Figma frame and review dynamic live content. Baselines are optional and are updated only by the explicit **Approve target as new visual baseline** action; a run never overwrites them.

The accessibility option runs axe-core against WCAG 2.1 A/AA tags. Treat results as a useful automated scan, not proof of full accessibility compliance. Keyboard, screen-reader, contrast, zoom, and manual workflow checks remain necessary.

## Task-specific tests

Create a task with a page, explicit expected result, and an executable JSON step list. Actions are `clickRole`, `clickText`, `fillLabel`, `expectText`, and `expectUrl`. Example:

```json
[
  { "action": "clickRole", "value": "link", "name": "Shop now" },
  { "action": "expectText", "value": "Product name" }
]
```

Review the selectors/labels and expected result, then check the approval box. If the outcome is ambiguous, clarify the product requirement before approval. A description alone is not executed. The runner deliberately blocks submit, subscribe, account creation, purchase, and checkout actions. It does not place orders, send email, or modify production data.

## Controlled demonstration

Select **Load safe demo**, then run Full regression on the local demo page. Its local-only preview intentionally has different styling from its local reference; the report should show a pixel diff. Run its approved task spec; the button intentionally shows a different confirmation than the expected text, so the task should fail with expected/actual details. This fixture does not contact or modify the real storefront. Use the dashboard reset or remove the demo page afterwards if desired.

## Automated tests and reports

```sh
npm test
npm run qa
npm run qa:report
```

- `npm test` validates configuration/safety rules and runs the browser runner against a local fixture. It deliberately verifies one visual difference and one failing task.
- `npm run qa` runs Playwright smoke tests against the local dashboard, using a fresh temporary data directory per invocation; it verifies page configuration persistence, mobile overflow, task failure reporting, recurring issue metadata, and history metrics. It does not test the live store.
- `npm run qa:report` opens Playwright's HTML smoke-test report after `npm run qa`.
- The dashboard creates `report.json`, `report.html`, full-page/viewport screenshots, pixel-diff PNGs, and optional baseline diffs inside each run directory. Reports can also be downloaded from the dashboard.

## Safety, privacy, and limits

- Only configure sites you own or have permission to test. Production tests are read-only checks; task runs are Preview-only. Do not configure a real customer account or personal data. Screenshots may contain page content, so keep local files private and delete run data when no longer needed.
- The app has no authentication because it binds to `127.0.0.1`; do not expose the port publicly or change the bind host without adding authentication and CSRF protections.
- Every same-origin internal link is checked, capped at 40 distinct destinations per page; checkout, cart mutation, logout, challenge, and order-tracking paths are excluded. HTTP 4xx responses are not globally treated as defects; missing links (404) and first-party 5xx responses are highlighted.
- There is no automatic natural-language-to-test generator. The editable structured spec plus explicit approval keeps generated actions reviewable and deterministic without a paid AI service. If a task needs a selector or an expected behavior is unclear, clarify it with the feature owner before running.
- Visual pixel diffs can flag legitimate content changes, personalization, cookie banners, and third-party rendering differences. Configure masks or document exceptions instead of approving a baseline automatically.
- Browser resource use is one Chromium process and one page at a time. To reduce runtime, select fewer pages, one viewport, functional-only mode, or disable accessibility scans. Reduce history retention to save disk space.

## Troubleshooting

- Browser launch error: run `npx playwright install chromium`. If Linux reports missing shared libraries, run `npx playwright install-deps chromium` where OS package installation is allowed.
- Preview unavailable or timed out: open the exact saved URL in a browser, confirm VPN/access/deployment state, and check that it does not require an unconfigured login. This runner does not store credentials.
- False visual regression: inspect the live and target viewport/full-page images, mask a stable dynamic selector, confirm the same consent state, and compare with the Figma design before approving a deliberate new baseline.
- Run stuck: cancel from the dashboard. Browser navigation and locator checks have bounded timeouts; an in-flight navigation may take until its navigation timeout to stop.
- Data reset: stop the server and remove the local `data/` folder only if you intend to delete all local configuration, history, screenshots, and baselines.

See [TEST-CASES.md](TEST-CASES.md) for the daily release checklist and storefront journey matrix.
