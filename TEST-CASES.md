# Daily Storefront QA Cases

Use the saved page list in the dashboard as the source of truth. Do not assume paths are identical between environments. Configure each page's exact Live/reference, Preview, and Production URL, and configure its Figma frame when a design comparison is required.

## Release setup

1. Record the task/build, select the changed page and its approved Figma frame, then configure/select the exact preview URL.
2. Confirm the release URLs are authorized and select Preview. Select the changed page for focused review; include all other enabled pages for regression.
3. Run Full regression at desktop and mobile breakpoints. For a shorter release check, select only the needed viewport or page subset.
4. Review every automated issue as a potential finding. Open live/target viewport screenshots, full-page screenshots, and pixel diffs. Compare the changed page with Figma. Dynamic content or legitimate live changes are not automatically defects.
5. Record manual results, defects, accepted differences, owner, and retest build. Only approve a new baseline after an explicit design review.

Do not submit a real form, subscribe, create an account, enter checkout, place an order, or modify production data. Task-specific tests are Preview-only and reject purchase, submit, subscription, and account-creation actions. Use approved test data and environments for any further workflow testing.

## Automated cases

| ID | Area | Expected result |
| --- | --- | --- |
| A01 | Configured route availability | Each selected page's exact URL for the chosen environment opens below HTTP 400, or a clear timeout/network issue is recorded. |
| A02 | Page structure | Main content and a primary H1 are present; optional configured title/H1 expectations match. |
| A03 | Runtime health | Uncaught page exceptions, console errors, and first-party 5xx responses are recorded with issue details. |
| A04 | Internal navigation | Up to 40 unique same-origin content links per page are checked; 404 and 5xx destinations are reported. Mutation, checkout, logout, and challenge paths are excluded. |
| A05 | Interactive names | Links and buttons expose visible or accessible names. |
| A06 | Media and responsive layout | Main-content images load and content does not overflow the selected viewport horizontally. |
| A07 | Visual regression | Live/reference and target are captured at identical viewport/device settings; full-page PNGs are pixel-compared and a diff/percentage is recorded. |
| A08 | Dynamic content and baselines | Configured CSS masks are applied consistently. Approved baselines change only after an explicit user action. |
| A09 | Accessibility (optional) | Axe reports WCAG 2.1 A/AA tagged violations separately from functional/UI issues. Manual accessibility testing remains required. |
| A10 | Task-specific behavior | Only reviewed, approved executable steps run on the selected Preview page; expected and actual outcomes are reported. |

## Manual acceptance cases

| ID | Area | Steps and expected result |
| --- | --- | --- |
| M01 | Figma fidelity | Compare the selected Preview page with its Figma frame at the same desktop and mobile sizes. Check section order, content width, spacing, typography, color, crop, borders, sticky UI, and intentional deviations. |
| M02 | Header and navigation | Check logo destination, desktop/mobile menus, quiz CTA, search, account, and cart. Destinations are correct; no dead links, clipped menu, or stuck overlay. |
| M03 | Homepage discovery | Check hero CTA, best sellers, shop-by-need links, reviews, footer, and back-to-top. Each destination is correct. |
| M04 | Collection browsing | Check product cards and destinations, sorting, filters, pagination/load-more, prices, sale labels, and combined-filter empty state where available. |
| M05 | Product details | Check gallery, variant/quantity controls, price, availability, purchase options, information accordions, and safe add-to-cart state in Preview only. Never continue into checkout. |
| M06 | Cart (Preview only) | If specifically authorized, check remove/quantity/totals and cart drawer/page consistency using test data. Do not place an order. |
| M07 | Quiz | Start, answer, back/next, required-answer validation, recommendations, and restart behavior work. |
| M08 | Search | Search known and no-result terms; verify suggestions, keyboard submission, and recovery. |
| M09 | Newsletter/forms | Use an approved test address to verify required/invalid feedback, success, and duplicate behavior. Do not send real customer email. |
| M10 | Footer/content | Check contact, ingredients, standards, shipping/refund/privacy, rewards/referral, and blog destinations and content. |
| M11 | Accessibility | Check keyboard order, visible focus, labels/names, heading hierarchy, contrast, 200% zoom, and keyboard traps. Automated axe is not a compliance certification. |
| M12 | Responsive and browser coverage | Check phone, tablet, and desktop; use other browsers when available. Confirm no overlap, clipped text, or horizontal scroll. |
| M13 | Consent and overlays | Check first/return visit, consent/announcement/promo state, dismissal, reopen behavior, and no trapped content. |
| M14 | Performance and SEO | Check relevant title/H1, metadata/canonical where expected, image availability, and layout movement while fonts/images load. |

## Issue record

For every unresolved finding, record the generated issue ID, page/environment, category, severity, expected/actual observation, exact URL, reproduction steps, screenshot/log evidence, next action, owner, and retest status. Distinguish observed behavior from suspected cause. Mark visual differences as potential regressions until checked against Figma or an explicit requirement.

## Daily release record

Record the date, task/build, selected environment, tested URLs, changed page, Figma URL, browser/viewports, run ID and summary, manual pass/fail/blocked status, accepted visual differences, defects and reproduction steps, owner, and retest result. A release is ready only when critical automated checks pass, M01-M13 pass or have a documented exception, and every blocker has been retested against the same preview build.
