# Acquisition-source findings

Audit date: 30 July 2026. This is an investigation record, not an
authorisation to acquire from any source. No new source adapter was built.

## Recorded interim BSE decision (31 July 2026)

Sutra will access BSE's public corporate-announcements endpoint at low volume
for a curated watchlist while pre-revenue. These are SEBI-mandated public
disclosures, and BSE's audit found no explicit anti-scraping term. The decision
is intentionally limited: the stated upgrade path is **BSE Corporate Data —
Announcements, EOD (₹5L/yr)** once Sutra has revenue.

The BSE client may establish the public announcement-page session and then use
browser-equivalent XHR headers at the enforced rate limits. It must stop on a
403 or 429; it must never use proxy rotation, IP cycling, CAPTCHA handling, or
any other way around a block. This exception applies **only** to BSE. NSE, ICRA,
and CRISIL remain disabled because their published terms contain explicit
prohibitions; that distinction is the line Sutra holds.

## Method

Each probe was a single `GET` from a plain command-line client, with no cookies,
`Origin`, `Referer`, browser user agent, browser automation, or retry workaround:

```sh
curl --silent --show-error --location --max-time 20 \
  --user-agent 'Sutra acquisition research/0.1 (+https://github.com/AKHILREDDYSYAMALA/Sutra)' \
  '<URL>'
```

The results below are the response observed on that date. A `200` only means a
single request responded; it does **not** mean that systematic acquisition is
permitted. Where terms prohibit it, that is decisive even if an individual
document is technically reachable.

## India Ratings (Ind-Ra) — needs more work

| Check | Exact request and response |
| --- | --- |
| Robots | `GET https://www.indiaratings.co.in/robots.txt` → `200 text/plain` (267 bytes). Its `User-agent: *` rules disallow administrative, temporary, private, and WordPress paths; they do not disallow `/pressrelease/`. |
| Official sitemap | `GET https://www.indiaratings.co.in/sitemap.xml` → `200 text/xml` (5,643 bytes). It exposes `https://www.indiaratings.co.in/pressrelease/` as the press-release route. |
| Public listing route | `GET https://www.indiaratings.co.in/pressrelease/` → `200 text/html` (6,918 bytes). The plain response is a small application shell, not a listing of recent releases. |
| Individual rationale | `GET https://www.indiaratings.co.in/pressrelease/83231` → `200 text/html` (6,918 bytes), the same application shell rather than the published rationale content. |

The sitemap establishes a public press-release route, but the honest static
response did not contain a usable recent-publication listing, rationale body,
or direct PDF URL. No documented public API or official RSS feed was found in
the robots file, sitemap, or initial public markup. No terms-of-use page was
located from those responses, so that must be resolved before any adapter is
considered.

**Verdict:** needs more work. Establish a documented feed/API or obtain written
permission for a low-rate listing endpoint; do not reverse engineer the client
application to make the shell useful.

## NSE corporate announcements — blocked

| Check | Exact request and response |
| --- | --- |
| Robots | `GET https://www.nseindia.com/robots.txt` → `200 text/plain` (96 bytes): `Allow: /`, with `/market-data-test` disallowed and `https://www.nseindia.com/sitemap.xml` declared. |
| Website and sitemap | Plain `GET https://www.nseindia.com/` and `GET https://www.nseindia.com/sitemap.xml` both failed with curl error 92 (`HTTP/2 stream ... INTERNAL_ERROR`) and no HTTP response body. |
| Announcements endpoint | `GET https://www.nseindia.com/api/corporate-announcements?index=equities&from_date=29-07-2026&to_date=30-07-2026` failed the same way (`HTTP 000`, zero bytes). |
| Terms page | Plain `GET https://www.nseindia.com/static/website-policies` failed the same way. The published [website policy](https://www.nseindia.com/static/website-policies) says users must not aggregate, copy, or duplicate site content and may face action for violations. |

The public endpoint commonly used by the website is not a documented acquisition
API, and it does not respond to our honest client. The published terms are also
incompatible with building the contemplated corpus from website content. No RSS
or bulk route was available from the accessible robots response.

**Verdict:** blocked. Do not add headers, cookie priming, browser automation, or
other workarounds. Reconsider only if NSE offers a licensed/documented feed.

## ICRA — blocked

| Check | Exact request and response |
| --- | --- |
| Robots | `GET https://www.icra.in/robots.txt` → `200 text/html`, redirected to `/Home/SessionTimeOut` (4,722 bytes), not a robots policy. |
| Recent listing | `GET https://www.icra.in/` → `200 text/html` (291,610 bytes). The public home page includes recent `/Rationale/ShowRationaleReport?id=…` entries and links to matching PDF endpoints. |
| Individual PDF | `GET https://www.icra.in/Rating/GetRationalReportFilePdf?id=142272` → `200 application/pdf` (1,360,063 bytes), with a stable identifier URL. |
| Sitemap | `GET https://www.icra.in/sitemap.xml` → the same `/Home/SessionTimeOut` HTML, not a sitemap. |
| Terms | `GET https://www.icra.in/Home/Disclaimer` → `200 text/html` (188,279 bytes). The [terms](https://www.icra.in/Home/Disclaimer) expressly prohibit scraping, data mining, and systematic extraction for databases. |

ICRA is technically straightforward: the home page lists recent rationales and
the individual PDFs fetch directly. Its terms explicitly prohibit the proposed
automation, however. No official RSS or documented public API was discovered.

**Verdict:** blocked by terms. Technical reachability is not a basis to build an
adapter.

## CARE Ratings — needs more work

| Check | Exact request and response |
| --- | --- |
| Robots | `GET https://www.careratings.com/robots.txt` → `200 text/plain` (26 bytes): `User-agent: *` with an empty `Disallow`. |
| Public search/listing | `GET https://www.careratings.com/find-ratings` → `200 text/html` (163,672 bytes). It is a public “Find Ratings” search page, but the static response did not expose a chronological recent-rationales feed or direct result links. |
| Sitemap | `GET https://www.careratings.com/sitemap` → `200 text/html` (136,148 bytes). The homepage links to it; `/sitemap.xml` instead returned `404`. |
| Individual PDF | `GET https://www.careratings.com/upload/CompanyFiles/RR/202410081047_Supertron_Electronics_Private_Limited.pdf` → `200 application/pdf` (226,239 bytes), unchanged after redirect following. |
| Policy | `GET https://www.careratings.com/disclaimer` → `200 text/html` (122,761 bytes). The homepage exposes this disclaimer and a privacy policy, but not a general terms-of-use or automation policy. |

CARE’s robots policy permits the paths checked, the search and sitemap pages are
public, and a publicly indexed rationale PDF is directly fetchable. That is not
yet enough for a production source: the static search page is not a deterministic
recent-publications listing, and the intended automated use needs explicit terms
or written permission. No official RSS or documented API was found in the
reviewed public routes.

**Verdict:** needs more work. Ask CARE for an approved feed/API or written
permission before designing the listing-query behaviour. Do not infer an
undocumented AJAX endpoint from the search UI.

## CRISIL Ratings — blocked

| Check | Exact request and response |
| --- | --- |
| Robots | `GET https://www.crisilratings.com/robots.txt` → `200 text/plain` (117,459 bytes). It disallows several named bots and many content paths, but not the tested `/mnt/winshare/Ratings/RatingList/RatingDocs/…` route under its `User-agent: *` rules. It declares `https://www.crisilratings.com/bin/sitemap.xml`. |
| Sitemap | `GET https://www.crisilratings.com/bin/sitemap.xml` → `200 application/xml` (638,757 bytes). It contains public ratings/publication pages, not a current chronological rationale-document feed. |
| Listing page | `GET https://www.crisilratings.com/en/home/our-business/ratings/rating-rationale.html` → `200 text/html` (104,532 bytes). |
| Individual rationale | `GET https://www.crisilratings.com/mnt/winshare/Ratings/RatingList/RatingDocs/EmbassyOfficeParksReit_July%2006_%202026_RR_399138.html` → `200 text/html` (255,502 bytes). The rationale is HTML rather than a PDF. |
| Terms | `GET https://www.crisilratings.com/en/home/website-terms-of-use.html` → `200 text/html` (79,888 bytes). The [terms](https://www.crisilratings.com/en/home/website-terms-of-use.html) prohibit use of bots, spiders, scrapers, code, or other tools to access, monitor, mirror, index, or use the site/content. |

Individual content responds to the honest client, but the terms expressly
forbid the contemplated automation. The sitemap is not a usable announcement
feed and no RSS or documented API was found.

**Verdict:** blocked by terms. Do not build a CRISIL adapter.

## Official RSS/API/bulk routes

No official RSS feed, documented public API, or bulk-download route suitable for
Sutra was found in the robots files, sitemaps, or public page markup reviewed.
The NSE and BSE JSON endpoints are website-internal/undocumented rather than
published acquisition interfaces and are not candidates for workaround-based
integration.

## BSE status — approved interim source

The BSE adapter remains a typed payload parser and source adapter. It now
establishes the public announcements-page session, retains its cookies, and
uses browser-equivalent XHR headers for the JSON call. The limits are enforced
in code: at least three seconds between every BSE request, no more than one poll
per 30 minutes, no more than 100 BSE requests per run, and at most three
consecutive retryable failures. A 403 or 429 disables the source for at least
24 hours and is visible in `watch:status`.

`npm run watch:bse -- --single --scrip <code>` is a read-only debugging mode:
it performs one session bootstrap and one API-page request, then prints the
returned announcement summaries without writing discovery rows or documents.

## Conclusion

BSE is the sole approved interim acquisition source under the recorded
low-volume decision above. No new adapter was added for any other source. The
next safe move for CARE or India Ratings remains an access/permission
conversation, not endpoint reverse engineering.
