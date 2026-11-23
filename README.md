# Deal Finder

A Chrome extension that tries coupon codes at checkout and keeps the one that saves the most. It also tracks prices on product pages. No affiliate links, no account, no tracking.

## Who it's for

People who want the coupon-tester part of Honey without the affiliate cookie swapping, the hidden codes, or the browsing data collection.

## What you get

- **Coupon tester.** On a cart or checkout page with a promo box, a small panel shows how many codes it found. Click **Try codes**. Codes are tried one at a time with a progress bar, and the best one stays applied. **Stop** ends early and keeps the best so far.
- **What each code did.** The amount it saved, "No change", or the store's rejection message.
- **Code track record.** The popup shows each code's source and how often it worked for you.
- **Price history.** Recorded on this computer when you visit a product page: now, lowest, highest, and a chart.
- **Droplist.** Set a target price. You get a Chrome notification when it drops. Checked every 6 hours where the store allows it.
- **Amazon sellers.** Cheapest seller on the page, counting shipping and Prime.
- **Check other stores.** Search links for Google Shopping, Amazon, Walmart, Target and eBay.
- **Savings history** and **your own codes** in the popup.
- **Your data, your call.** Pause on all sites, or Clear my data (with a confirm step).

No cash back, by choice: it needs affiliate links, and Deal Finder uses none.

Codes come from the page you are on, the store's own homepage and promo pages (after checking its `robots.txt`, cached 12 hours, at most one request every 2 seconds), your own codes, codes that worked for you before, and the open list in `data/codes.json`. Full rules: [docs/PRD.md](docs/PRD.md).

## Install (Load unpacked)

1. Download or clone this folder.
2. Open `chrome://extensions` in Chrome (or `edge://extensions` in Edge).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `deal-finder` folder (the one with `manifest.json`).
5. Pin Deal Finder from the puzzle-piece menu so the % icon stays in the toolbar.
6. Reload any store tabs that were already open.

To update after pulling changes, click the reload arrow on the Deal Finder card in `chrome://extensions`.

## Tested

On 2026-11-22 and 23 in Edge with the extension loaded unpacked, on real Shopify checkouts, with no orders placed:

| Store | Codes found | Result | Screenshot |
| --- | --- | --- | --- |
| tentree.com | GREEN15 (homepage banner) | Removed the GREEN15 already applied, then measured it: saved $61.95 on $413.00, left applied | `docs/screenshots/tentree.com-3-result.png` |
| mvmt.com | BF30, BOGO_50 (homepage banner) | Day 1: BF30 saved $241.92 and was kept. Day 2: the store ended BF30 ("Enter a valid discount code"), so BOGO_50 was applied, saving $144.00 on $720.00 | `docs/screenshots/mvmt.com-3-result.png` |

Droplist: a watch on an mvmt.com product with a target above its price fetched the live price ($134.40) and fired the notification. Popup: `docs/screenshots/popup-product-page.png`, `docs/screenshots/popup-droplist.png`.

## What's unfinished

- Fewer codes than Honey. No paid code database and no affiliate feed, on purpose.
- Price history starts on your first visit. No free price-history API covers most stores.
- Big custom checkouts (Amazon, Walmart, Target) have no checkout adapters yet.
- No Firefox build, not on the Chrome Web Store.
