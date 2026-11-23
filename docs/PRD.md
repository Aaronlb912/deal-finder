# Deal Finder: PRD

Status: v1 built 2026-11-22, Honey feature pass added the same day. Personal project, separate from AniThrift and Did I.

## Who it's for

People who shop online and want the best working coupon at checkout without handing a company their browsing history or letting it take a cut of every order behind their back.

## What you get

- **Coupon tester at checkout.** On a cart or checkout page with a promo box, a small panel shows how many codes it found. Click Try codes. It enters them one at a time with a progress bar, reads the order total after each, and keeps the one that saves the most. A Stop button ends the run and still applies the best code so far. At most 15 codes per run, best track record first.
- **Real savings per code.** Every code shows what it did: the amount it took off, "no change", or the store's rejection message.
- **Store codes with a track record.** The popup lists every code for the store, where it came from, and "worked 2 of 3 times, last 3 days ago" from your own runs.
- **Price history.** On product pages that publish a price (schema.org Product data), it records the price locally on each visit and shows now, low, high and a chart.
- **Droplist.** Set a target price on a product. Deal Finder re-checks it every 6 hours where the store's robots.txt allows, and sends a Chrome notification when it drops to the target.
- **Amazon seller comparison.** On an Amazon product page, the popup lists sellers from the page with price plus shipping and Prime, cheapest first. "Compare all sellers" opens Amazon's own offers panel in your tab and reads it.
- **Cheaper elsewhere.** One-click searches on Google Shopping, Amazon, Walmart, Target and eBay. Nothing is sent until you click.
- **Savings history.** Total saved and the last checkouts where a code stayed applied.
- **Your own codes.** Paste a code from an email and it is tried next time at that store.
- **Undo.** Removing a Droplist item shows an Undo bar for 8 seconds.
- **Data controls.** Pause on all sites (no panel, no tracking, no Droplist checks) and Clear my data with a confirm step.

## Honey parity

| Honey feature | Deal Finder |
| --- | --- |
| Automatic coupon testing | Yes, with progress bar, Stop, and the result of every code shown |
| Code success rates on store pages | Yes, from your own runs only (no shared database) |
| Droplist with price alerts | Yes, stored locally, Chrome notifications |
| Price history (Amazon and major stores) | Yes, recorded from your visits. No paid history API |
| Amazon "best seller" comparison | Yes, counts shipping and Prime |
| Savings total | Yes, local |
| PayPal Rewards / Honey Gold cash back | Out of scope by choice. Cash back needs affiliate links, which we do not use at all |
| AI shopping assistant, mobile app | Out of scope for v1 |

## Where codes come from

Only public sources that are allowed to be read:

1. **The page you are on.** Codes the store prints in banners and popups ("use code SAVE15").
2. **The store's own pages.** Its homepage and `/pages/promotions`, `/promotions`, `/offers`. Fetched only after checking that store's `robots.txt`, cached 12 hours, at most one request every 2 seconds per site and 40 per hour in total. Requests carry no cookies.
3. **Your codes and past wins.** Stored in Chrome on your machine.
4. **The open codes list** in `data/codes.json`. A copy ships with the extension. Once a day it also fetches the same file from the public repo (`raw.githubusercontent.com/Aaronlb912/deal-finder/main/data/codes.json`), so new codes arrive without a release. That request is a plain GET of one static file: no cookies, no referrer, no query string. GitHub sees the request's IP address and browser type, like any download. Nothing else is sent. Malformed entries are dropped. If the fetch fails, the last good copy and the bundled list are used. Only codes checked against the store's own site go in.

No coupon aggregator sites are scraped. Their terms forbid it. Amazon is never fetched in the background; its terms forbid automated access, so Amazon data comes only from pages you open.

## Hard rules

| Rule | How it is enforced |
| --- | --- |
| No affiliate links, no cookie swapping, no taking over creators' referral links | No affiliate program, no redirects, no rewriting of links or cookies. The code has no affiliate IDs. |
| Never hide better codes | There are no partners. Codes are ranked by your own results; the best measured saving is applied. |
| Collect no browsing data | No analytics, no account, no server. Everything lives in `chrome.storage.local`. Network requests go to stores (the one you are on, and the product pages on your Droplist) and to one static codes file, once a day. |
| Show what each code saved | Every tested code lists its measured change to the order total. |

## Limits and honesty

- Coverage is smaller than Honey's. Honey buys code feeds from affiliate networks. We do not, by choice.
- Price history starts the first time you visit a product (or add it to the Droplist).
- Applying codes depends on finding the promo box and the total on the page. Shopify, WooCommerce, BigCommerce and Magento have known selectors, plus a general matcher.
- Savings counts codes left applied. It cannot see whether you placed the order.

## Not built yet

- The daily refresh only reads stores listed in `data/sources.json`. Adding stores is manual.
- Checkout adapters with test fixtures for Amazon, Target, Walmart and other custom checkouts.
- Firefox and Safari builds. Chrome Web Store listing.
