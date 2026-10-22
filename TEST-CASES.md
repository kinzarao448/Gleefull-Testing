# Daily Storefront QA Cases

Use each saved row as a Preview/Live pair. Enter the exact matching page URL in both columns; routes may differ between environments.

## Release setup

1. Add one Preview/Live pair for every page in the release scope.
2. Confirm both URLs point to the correct release and live pages.
3. Select **Run Regression Tests**. Every saved pair is checked on desktop and mobile.
4. Review issue page number, detected URL, expected/observed details, screenshots, and visual-diff percentage. Live content changes can be intentional and require review.
5. Retest fixes using the same pair and record the run ID for release notes.

The automated runner does not submit forms, click purchase/order controls, or modify site data. Form checks inspect labels and native required-field validity without submitting. Interactions with side effects require a separate approved manual test plan and safe test data.

## Automated cases

| ID | Area | Expected result |
| --- | --- | --- |
| A01 | URL validation | Each row requires complete Preview and Live HTTP(S) URLs before the run starts. |
| A02 | Page availability | Each Preview page opens with an HTTP status below 400; failures identify the pair and URL. |
| A03 | Functional page health | Main content/H1, named links and buttons, internal destinations, runtime errors, and first-party 5xx responses are checked. |
| A04 | Forms | Required fields have labels, and native browser validity rejects empty required values; no form is submitted. |
| A05 | Media and responsive layout | Main-content images load and the page does not overflow horizontally at desktop or mobile width. |
| A06 | Basic performance | DOMContentLoaded is measured; times over 15 seconds are reported for review. |
| A07 | Visual regression | Preview and Live screenshots are captured at identical desktop/mobile settings; full-page PNGs are pixel-compared and a diff is generated. |
| A08 | Functional/content differences | Preview title and H1 are compared with Live; observed differences include expected/actual content and affected URL. |
| A09 | Error summary | Every issue includes its page pair, category, severity, details, and available screenshot/network evidence. |

## Manual acceptance cases

| ID | Area | Steps and expected result |
| --- | --- | --- |
| M01 | Visual review | Compare Preview and Live screenshots at the same desktop and mobile sizes. Review layout, text, typography, color, image crop, and dynamic content. |
| M02 | Header and navigation | Check logo destination, desktop/mobile menus, quiz CTA, search, account, and cart. Destinations are correct; no dead links, clipped menu, or stuck overlay. |
| M03 | Homepage discovery | Check hero CTA, best sellers, shop-by-need links, reviews, footer, and back-to-top. Each destination is correct. |
| M04 | Collection browsing | Check product cards and destinations, sorting, filters, pagination/load-more, prices, sale labels, and combined-filter empty state where available. |
| M05 | Product details | Manually check gallery, variants/quantity, price, availability, information accordions, and safe cart behavior in an approved test environment. Do not place an order. |
| M06 | Cart | Manually check cart updates and totals with approved test data. Do not enter checkout or place an order. |
| M07 | Quiz | Start, answer, back/next, required-answer validation, recommendations, and restart behavior work. |
| M08 | Search | Search known and no-result terms; verify suggestions, keyboard submission, and recovery. |
| M09 | Newsletter/forms | Use an approved test address to verify validation and success behavior. The automated run does not submit forms or send email. |
| M10 | Footer/content | Check contact, ingredients, standards, shipping/refund/privacy, rewards/referral, and blog destinations and content. |
| M11 | Accessibility | Check keyboard order, visible focus, labels/names, heading hierarchy, contrast, 200% zoom, and keyboard traps. Automated axe is not a compliance certification. |
| M12 | Responsive and browser coverage | Check phone, tablet, and desktop; use other browsers when available. Confirm no overlap, clipped text, or horizontal scroll. |
| M13 | Consent and overlays | Check first/return visit, consent/announcement/promo state, dismissal, reopen behavior, and no trapped content. |
| M14 | Performance and SEO | Check relevant title/H1, metadata/canonical where expected, image availability, and layout movement while fonts/images load. |

## Issue record

For every unresolved finding, record the generated issue ID, pair/page number, category, severity, expected/observed result, exact URL, screenshot/log evidence, next action, owner, and retest status. Distinguish observed behavior from suspected cause. Treat pixel differences as potential regressions until reviewed.

## Daily release record

Record the date, task/build, Preview/Live pairs, browser/viewports, run ID and summary, manual pass/fail/blocked status, accepted differences, defects and reproduction steps, owner, and retest result. A release is ready only when critical automated checks pass, required manual journeys are reviewed, and every blocker has been retested against the same Preview build.
